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

//! Engine ADR 1055 — the comment threads as annotations, as Acrobat's Comment
//! tool writes them. A comment read from a PDF keeps its annotation (format
//! `pdf-annot`); while the model still says what that annotation says, the
//! annotation is written back from it, its rectangles moved to where the thread
//! stands now and its references (`/P`, `/IRT`, `/Popup`) rebuilt for this file.
//! A comment edited in paged, or made in paged, is written from the model.

use paged_model::ReviewState;
use paged_pdf_annots::kept::{read_kept, Kept, KeptAnnot, Value};
use pdf_writer::{Name, Obj, Pdf, Rect, Ref, Str};

use crate::writer::{FinishedPage, RefAllocator};

/// A PDF date from an ISO 8601 one (`2026-11-01T10:30:00.250Z`,
/// `2026-11-01T10:30:00+02:00`, `2026-11-01`): the fields it gives, a time
/// zone only with a full time. `None` when it does not start with a year.
fn pdf_date(iso: &str) -> Option<pdf_writer::Date> {
    let b = iso.as_bytes();
    let num = |from: usize, len: usize| -> Option<u32> {
        let s = iso.get(from..from + len)?;
        s.bytes()
            .all(|c| c.is_ascii_digit())
            .then(|| s.parse().ok())?
    };
    let mut d = pdf_writer::Date::new(num(0, 4)? as u16);
    if b.get(4) != Some(&b'-') {
        return Some(d);
    }
    d = d.month(num(5, 2)? as u8);
    if b.get(7) != Some(&b'-') {
        return Some(d);
    }
    d = d.day(num(8, 2)? as u8);
    if !matches!(b.get(10), Some(b'T') | Some(b' ')) {
        return Some(d);
    }
    d = d.hour(num(11, 2)? as u8);
    if b.get(13) != Some(&b':') {
        return Some(d);
    }
    d = d.minute(num(14, 2)? as u8);
    if b.get(16) != Some(&b':') {
        return Some(d);
    }
    d = d.second(num(17, 2)? as u8);
    // Skip fractional seconds, then the zone.
    let mut at = 19;
    if b.get(at) == Some(&b'.') {
        at += 1;
        while b.get(at).is_some_and(u8::is_ascii_digit) {
            at += 1;
        }
    }
    match b.get(at) {
        Some(b'Z') => Some(d.utc_offset_hour(0)),
        Some(sign @ (b'+' | b'-')) => {
            let hour = num(at + 1, 2)? as i8;
            let minute = if b.get(at + 3) == Some(&b':') {
                num(at + 4, 2)? as u8
            } else {
                num(at + 3, 2).unwrap_or(0) as u8
            };
            let hour = if *sign == b'-' { -hour } else { hour };
            Some(d.utc_offset_hour(hour).utc_offset_minute(minute))
        }
        _ => Some(d),
    }
}

/// Write the comment threads as annotations, appending their refs to each
/// page's annotation list. Each thread is a Text annotation (the sticky note)
/// at its point; each reply a Text annotation in reply to it (`/IRT`,
/// `/RT /R`); a resolved thread, or one with a review state, gets the state
/// annotation Acrobat writes (`/State`, `/StateModel /Review`). A comment whose
/// kept annotation still matches it is that annotation instead (module note).
pub(crate) fn write_comments(
    pdf: &mut Pdf,
    refs: &mut RefAllocator,
    comments: &[crate::PdfComment],
    pages: &[FinishedPage],
    first_page: usize,
    annots_per_page: &mut [Vec<Ref>],
) {
    use pdf_writer::types::{AnnotationFlags, AnnotationIcon, AnnotationType};
    use pdf_writer::TextStr;

    const SIZE: f32 = 20.0;
    // Print off, NoZoom and NoRotate, as a sticky note is shown.
    let flags = || AnnotationFlags::NO_ZOOM | AnnotationFlags::NO_ROTATE;
    for c in comments {
        let Some(page_idx) = c.page_index.checked_sub(first_page) else {
            continue;
        };
        let Some(page) = pages.get(page_idx) else {
            continue;
        };
        // The page's own coordinate space starts at the trim box's top-left.
        // (In the page's user unit, engine ADR 1094.)
        let left = page.trim_box.x1 + c.at[0] / page.user_unit;
        let top = page.trim_box.y2 - c.at[1] / page.user_unit;
        let rect = Rect::new(left, top - SIZE, left + SIZE, top);
        let root = refs.alloc();
        let annots = &mut annots_per_page[page_idx];
        annots.push(root);

        // The kept root fixes where every kept annotation of the thread goes.
        let root_kept = c.kept.as_deref().and_then(read_kept);
        let place = root_kept
            .as_ref()
            .and_then(|k| Placement::new(&k.annot, left as f64, top as f64));
        let note = |pdf: &mut Pdf,
                    id: Ref,
                    id_text: &str,
                    author: &str,
                    date: &Option<String>,
                    text: &str,
                    parent: Option<Ref>| {
            let mut a = pdf.annotation(id);
            a.subtype(AnnotationType::Text);
            a.rect(rect);
            a.contents(TextStr(text));
            a.author(TextStr(author));
            a.name(TextStr(id_text));
            a.flags(flags());
            if let Some(d) = date.as_deref().and_then(pdf_date) {
                a.modified(d);
            }
            match parent {
                None => {
                    a.icon(AnnotationIcon::Comment);
                    a.pair(Name(b"Open"), false);
                }
                Some(p) => {
                    a.pair(Name(b"IRT"), p);
                    a.pair(Name(b"RT"), Name(b"R"));
                }
            }
        };
        match kept_as(&root_kept, place, &c.author, &c.date, &c.text) {
            Some((k, p)) => {
                let popup = refs.alloc();
                annots.push(popup);
                let shown = write_kept(pdf, root, &k.annot, &p, page.page_ref, None, Some(popup));
                write_popup(pdf, popup, root, shown, page.page_ref);
            }
            None => note(pdf, root, &c.id, &c.author, &c.date, &c.text, None),
        }
        for r in &c.replies {
            let id = refs.alloc();
            annots.push(id);
            let kept = r.kept.as_deref().and_then(read_kept);
            match kept_as(&kept, place, &r.author, &r.date, &r.text) {
                Some((k, p)) => {
                    write_kept(pdf, id, &k.annot, &p, page.page_ref, Some(root), None);
                    for s in &k.states {
                        let sid = refs.alloc();
                        annots.push(sid);
                        write_kept(pdf, sid, s, &p, page.page_ref, Some(id), None);
                    }
                }
                None => note(pdf, id, &r.id, &r.author, &r.date, &r.text, Some(root)),
            }
        }

        // The kept states, while the model's state is still theirs.
        let kept_resolved = |k: &Kept| k.review_state() == Some(ReviewState::Completed);
        if let (Some(k), Some(p)) = (&root_kept, place) {
            if c.review_state.is_none() && c.resolved == kept_resolved(k) {
                for s in &k.states {
                    let sid = refs.alloc();
                    annots.push(sid);
                    write_kept(pdf, sid, s, &p, page.page_ref, Some(root), None);
                }
                continue;
            }
        }
        let state = c
            .review_state
            .as_deref()
            .or(c.resolved.then_some("Completed"));
        if let Some(state) = state {
            let id = refs.alloc();
            annots.push(id);
            let mut a = pdf.annotation(id);
            a.subtype(AnnotationType::Text);
            a.rect(rect);
            a.author(TextStr(&c.author));
            a.flags(flags() | AnnotationFlags::HIDDEN);
            if let Some(d) = c.date.as_deref().and_then(pdf_date) {
                a.modified(d);
            }
            a.pair(Name(b"IRT"), root);
            a.pair(Name(b"RT"), Name(b"R"));
            a.pair(Name(b"StateModel"), TextStr("Review"));
            a.pair(Name(b"State"), TextStr(state));
        }
    }
}

/// The kept annotation and where it goes, when the comment is unedited and the
/// thread's root has a kept place.
fn kept_as<'k>(
    kept: &'k Option<Kept>,
    place: Option<Placement>,
    author: &str,
    date: &Option<String>,
    text: &str,
) -> Option<(&'k Kept, Placement)> {
    kept.as_ref()
        .filter(|k| unedited(&k.annot, author, date, text))
        .zip(place)
}

/// Whether the model's comment still says what its kept annotation says: the
/// text, the author (a kept annotation without `/T` takes any) and the date
/// (`/M`, else `/CreationDate`, as the canvas hands the model's on).
fn unedited(k: &KeptAnnot, author: &str, date: &Option<String>, text: &str) -> bool {
    k.comment.text == text
        && k.comment.author.as_deref().is_none_or(|a| a == author)
        && k.comment.modified.as_ref().or(k.comment.date.as_ref()) == date.as_ref()
}

/// Where a kept annotation goes on the destination page: the source page's
/// rotation undone (user space to user space, both y up), then moved so that
/// the corner the reader anchored the thread at lands on the thread's point now.
#[derive(Debug, Clone, Copy)]
struct Placement {
    rotate: u32,
    dx: f64,
    dy: f64,
}

impl Placement {
    /// `left` / `top`: the thread's point in the destination's user space.
    fn new(root: &KeptAnnot, left: f64, top: f64) -> Option<Self> {
        let mut p = Placement {
            rotate: root.rotate,
            dx: 0.0,
            dy: 0.0,
        };
        let markup = matches!(
            root.subtype.as_str(),
            "Highlight" | "Underline" | "StrikeOut" | "Squiggly"
        );
        let quads = markup
            .then(|| root.get(b"QuadPoints").and_then(Value::numbers))
            .flatten()
            .filter(|q| q.len() >= 2);
        let pts = match quads {
            Some(q) => q,
            None => corners(&root.get(b"Rect")?.numbers().filter(|r| r.len() >= 4)?),
        };
        let (x0, _, _, y1) = p.bounds(&pts)?;
        p.dx = left - x0;
        p.dy = top - y1;
        Some(p)
    }

    fn map(&self, x: f64, y: f64) -> (f64, f64) {
        let (x, y) = match self.rotate {
            90 => (y, -x),
            180 => (-x, -y),
            270 => (-y, x),
            _ => (x, y),
        };
        (x + self.dx, y + self.dy)
    }

    /// The bounding box `(x0, y0, x1, y1)` of mapped `[x, y, …]` pairs.
    fn bounds(&self, xy: &[f64]) -> Option<(f64, f64, f64, f64)> {
        let mut b: Option<(f64, f64, f64, f64)> = None;
        for pt in xy.as_chunks::<2>().0 {
            let (x, y) = self.map(pt[0], pt[1]);
            b = Some(match b {
                None => (x, y, x, y),
                Some((a, c, d, e)) => (a.min(x), c.min(y), d.max(x), e.max(y)),
            });
        }
        b
    }
}

/// The four corners of `[x0, y0, x1, y1]` as `[x, y, …]`.
fn corners(r: &[f64]) -> Vec<f64> {
    vec![r[0], r[1], r[2], r[1], r[0], r[3], r[2], r[3]]
}

/// Write a kept annotation as object `id`: its entries as kept, the
/// rectangle and point lists placed, `/P` this page, `/IRT` and `/Popup` the
/// refs given. Returns the placed `/Rect`.
fn write_kept(
    pdf: &mut Pdf,
    id: Ref,
    k: &KeptAnnot,
    place: &Placement,
    page: Ref,
    irt: Option<Ref>,
    popup: Option<Ref>,
) -> Option<Rect> {
    let mut shown = None;
    let mut d = pdf.indirect(id).dict();
    for (key, v) in &k.entries {
        // Rebuilt below for this file, should a kept dictionary hold one.
        if matches!(key.as_slice(), b"P" | b"IRT" | b"Popup" | b"Parent") {
            continue;
        }
        let numbers = v.numbers();
        match (key.as_slice(), numbers) {
            (b"Rect", Some(r)) if r.len() == 4 => {
                let (x0, y0, x1, y1) = place.bounds(&corners(&r)).expect("four corners");
                let rect = Rect::new(x0 as f32, y0 as f32, x1 as f32, y1 as f32);
                d.pair(Name(b"Rect"), rect);
                shown = Some(rect);
            }
            (b"QuadPoints" | b"CL" | b"Vertices", Some(xy)) if xy.len() % 2 == 0 => {
                let mut a = d.insert(Name(key)).array();
                for pt in xy.as_chunks::<2>().0 {
                    let (x, y) = place.map(pt[0], pt[1]);
                    a.item(x as f32);
                    a.item(y as f32);
                }
            }
            _ => write_value(d.insert(Name(key)), v),
        }
    }
    d.pair(Name(b"P"), page);
    if let Some(r) = irt {
        d.pair(Name(b"IRT"), r);
    }
    if let Some(p) = popup {
        d.pair(Name(b"Popup"), p);
    }
    shown
}

/// The closed pop-up window of a written-back annotation, beside it.
fn write_popup(pdf: &mut Pdf, id: Ref, parent: Ref, at: Option<Rect>, page: Ref) {
    let at = at.unwrap_or(Rect::new(0.0, 0.0, 0.0, 0.0));
    let mut d = pdf.indirect(id).dict();
    d.pair(Name(b"Type"), Name(b"Annot"));
    d.pair(Name(b"Subtype"), Name(b"Popup"));
    d.pair(
        Name(b"Rect"),
        Rect::new(at.x2, at.y2 - 120.0, at.x2 + 180.0, at.y2),
    );
    d.pair(Name(b"Parent"), parent);
    d.pair(Name(b"P"), page);
    d.pair(Name(b"Open"), false);
}

fn write_value(obj: Obj<'_>, v: &Value) {
    match v {
        Value::Null => obj.primitive(pdf_writer::Null),
        Value::Bool(b) => obj.primitive(*b),
        Value::Number(n) if n.fract() == 0.0 && n.abs() < i32::MAX as f64 => {
            obj.primitive(*n as i32)
        }
        Value::Number(n) => obj.primitive(*n as f32),
        Value::String(s) => obj.primitive(Str(s)),
        Value::Name(n) => obj.primitive(Name(n)),
        Value::Array(items) => {
            let mut a = obj.array();
            for item in items {
                write_value(a.push(), item);
            }
        }
        Value::Dict(entries) => {
            let mut d = obj.dict();
            for (k, item) in entries {
                write_value(d.insert(Name(k)), item);
            }
        }
    }
}
