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

//! Engine ADR 1022 — Word fields: their live results at emit, and their
//! updated results (Word's F9) over a build.
//!
//! A field run carries its last result as its text. At emit the
//! page-dependent kinds ([`paged_model::WordField::is_live`]) print what the
//! current layout says (`PAGE`, `NUMPAGES`, `SECTIONPAGES`, `PAGEREF`,
//! `STYLEREF`), the way InDesign prints a cross-reference's page number live;
//! "show field codes" prints every field's code in braces instead. An update
//! ([`updated_field_paragraphs`]) writes every kind's result into the runs:
//! `DATE` / `TIME` from the clock the host passes, `REF` from the
//! bookmark's paragraph, `SEQ` counted in document order.

use std::collections::HashMap;

use paged_model::word_field::{format_word_date, CivilDateTime};
use paged_model::{Paragraph, StoryDestination, WordField, WordFieldKind};
use paged_scene::Document;

use super::links::VarResolveCtx;

/// Word's text for a `REF` whose bookmark the document lacks.
pub const REF_ERROR: &str = "Error! Reference source not found.";
/// Word's text for a `PAGEREF` whose bookmark the document lacks.
pub const PAGEREF_ERROR: &str = "Error! Bookmark not defined.";

/// The prefix under which the post-layout pass records each bookmark's page
/// in the cross-reference page map (by `Self` and by name).
pub(crate) const BOOKMARK_KEY: &str = "\u{1}bookmark:";

/// The paragraph style a `STYLEREF` names: its `Self`, its display name, or
/// `ParagraphStyle/<name>`.
pub fn style_ref_id(document: &Document, name: &str) -> Option<String> {
    let styles = &document.styles.paragraph_styles;
    if styles.contains_key(name) {
        return Some(name.to_string());
    }
    let prefixed = format!("ParagraphStyle/{name}");
    if styles.contains_key(&prefixed) {
        return Some(prefixed);
    }
    styles
        .iter()
        .find(|(_, s)| {
            s.name
                .as_deref()
                .is_some_and(|n| n.eq_ignore_ascii_case(name))
        })
        .map(|(id, _)| id.clone())
}

/// The text destination a field names: by name (Word's bookmark name), else
/// by `Self`. With the story that holds it.
pub fn find_bookmark<'d>(
    document: &'d Document,
    bookmark: &str,
) -> Option<(&'d str, &'d StoryDestination)> {
    let all = || {
        document.stories.iter().flat_map(|s| {
            s.story
                .destinations
                .iter()
                .map(move |d| (s.self_id.as_str(), d))
        })
    };
    all()
        .find(|(_, d)| d.name.as_deref() == Some(bookmark))
        .or_else(|| all().find(|(_, d)| d.self_id == bookmark))
}

fn plain(text: &str) -> String {
    text.chars()
        .filter(|c| !paged_model::is_generated_marker(*c))
        .collect::<String>()
}

/// A bookmark's text: its paragraph's, from the bookmark on (the whole
/// paragraph for a paragraph destination), without the paragraph break.
pub fn bookmark_text(document: &Document, bookmark: &str) -> Option<String> {
    let (story, dest) = find_bookmark(document, bookmark)?;
    let para = document
        .stories
        .iter()
        .find(|s| s.self_id == story)?
        .story
        .paragraphs
        .get(dest.paragraph as usize)?;
    let text: String = para.runs.iter().map(|r| r.text.as_str()).collect();
    let from = if dest.paragraph_destination {
        0
    } else {
        dest.offset as usize
    };
    let text: String = text.chars().skip(from).collect();
    Some(
        plain(&text)
            .trim_end_matches(['\n', '\r'])
            .trim()
            .to_string(),
    )
}

/// Whether any story carries a field that only the post-layout pass can
/// resolve (`PAGEREF`, `STYLEREF`).
pub(crate) fn document_needs_post_layout(document: &Document) -> bool {
    document.stories.iter().any(|s| {
        s.story.paragraphs.iter().any(|p| {
            p.runs.iter().any(|r| {
                r.field.as_ref().is_some_and(|f| {
                    matches!(
                        f.kind,
                        WordFieldKind::PageRef { .. } | WordFieldKind::StyleRef { .. }
                    )
                })
            })
        })
    })
}

/// The styles the document's `STYLEREF` fields match, as style ids.
pub(crate) fn style_ref_styles(document: &Document) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for s in &document.stories {
        for p in &s.story.paragraphs {
            for r in &p.runs {
                if let Some(WordFieldKind::StyleRef { style, .. }) =
                    r.field.as_ref().map(|f| &f.kind)
                {
                    if let Some(id) = style_ref_id(document, style) {
                        if !out.contains(&id) {
                            out.push(id);
                        }
                    }
                }
            }
        }
    }
    out
}

/// What a field prints at emit: its code under "show field codes", the
/// current layout's answer for the live kinds, else `None` (its result).
/// `xref_pages` holds the bookmarks' pages on the post-layout pass
/// ([`BOOKMARK_KEY`]); `here` is the field's own (story, paragraph).
pub(crate) fn resolve_at_emit(
    field: &WordField,
    document: &Document,
    ctx: &VarResolveCtx,
    xref_pages: Option<&HashMap<String, usize>>,
    here: Option<(&str, u32)>,
) -> Option<String> {
    if document.designmap.document_preference.show_field_codes == Some(true) {
        return Some(field.code_display());
    }
    let host = ctx.page_index;
    match &field.kind {
        WordFieldKind::Page => match field.number_format {
            Some(_) => ctx
                .numbering
                .numbers
                .get(host)
                .map(|n| field.format_number(*n)),
            None => ctx.page_labels.get(host).cloned(),
        },
        WordFieldKind::NumPages => Some(field.format_number(ctx.total_pages as u32)),
        WordFieldKind::SectionPages => {
            let section = ctx.numbering.section_of.get(host).copied()?;
            let n = ctx
                .numbering
                .section_of
                .iter()
                .filter(|s| **s == section)
                .count();
            Some(field.format_number(n as u32))
        }
        WordFieldKind::PageRef { bookmark, relative } => {
            // The first pass has no layout to read: keep the result.
            let pages = xref_pages?;
            let Some((story, dest)) = find_bookmark(document, bookmark) else {
                return Some(PAGEREF_ERROR.to_string());
            };
            let page = pages
                .get(&format!("{BOOKMARK_KEY}{}", dest.self_id))
                .copied()?;
            Some(page_ref_text(
                field,
                ctx.page_labels,
                &ctx.numbering.numbers,
                page,
                *relative,
                host,
                here,
                (story, dest.paragraph),
            ))
        }
        WordFieldKind::StyleRef { style, last } => {
            let index = ctx.running_headers?;
            let id = style_ref_id(document, style)?;
            Some(index.resolve(host, &id, *last).unwrap_or_default())
        }
        _ => None,
    }
}

#[allow(clippy::too_many_arguments)]
fn page_ref_text(
    field: &WordField,
    labels: &[String],
    numbers: &[u32],
    page: usize,
    relative: bool,
    host: usize,
    here: Option<(&str, u32)>,
    target: (&str, u32),
) -> String {
    let label = match field.number_format {
        Some(_) => numbers
            .get(page)
            .map(|n| field.format_number(*n))
            .unwrap_or_default(),
        None => labels.get(page).cloned().unwrap_or_default(),
    };
    if !relative {
        return label;
    }
    if page != host {
        return format!("on page {label}");
    }
    // On the field's own page: "above" when the bookmark comes first.
    let above = match here {
        Some((story, para)) if story == target.0 => target.1 <= para,
        _ => true,
    };
    if above { "above" } else { "below" }.to_string()
}

/// What an update reads: the document, the last build's paragraph pages and
/// page labels, each page's number and section, and the host's clock.
pub struct FieldUpdate<'a> {
    pub document: &'a Document,
    /// Story → paragraph → flat page index (`BuiltDocument::paragraph_pages`).
    pub paragraph_pages: &'a paged_scene::ParagraphPages,
    /// Every built page's label, by flat index.
    pub page_labels: &'a [String],
    /// Every built page's number by the section rules, by flat index.
    pub page_numbers: &'a [u32],
    /// Every built page's section (an index into the document's sections),
    /// by flat index.
    pub page_sections: &'a [Option<usize>],
    /// The clock `DATE` and `TIME` read; `None` keeps their results.
    pub now: Option<CivilDateTime>,
}

/// One field's place: story, paragraph, run, and its story char offset.
struct Place {
    story: usize,
    paragraph: usize,
    run: usize,
    offset: u32,
}

/// Word's F9 over `upd`: every field's new result, written into a copy of
/// the paragraphs of each story it changes. `only_story` limits the update
/// to one story, and `only_offset` (with it) to the field run starting at
/// that story char offset. `SEQ` numbers are counted over the whole
/// document whatever is updated. Returns `(story id, paragraphs)` for each
/// story whose text changes, in document order.
pub fn updated_field_paragraphs(
    upd: &FieldUpdate,
    only_story: Option<&str>,
    only_offset: Option<u32>,
) -> Vec<(String, Vec<Paragraph>)> {
    let doc = upd.document;
    let mut places: Vec<Place> = Vec::new();
    for (si, s) in doc.stories.iter().enumerate() {
        let mut offset = 0u32;
        for (pi, p) in s.story.paragraphs.iter().enumerate() {
            for (ri, r) in p.runs.iter().enumerate() {
                if r.field.is_some() {
                    places.push(Place {
                        story: si,
                        paragraph: pi,
                        run: ri,
                        offset,
                    });
                }
                offset += r.text.chars().count() as u32;
            }
        }
    }
    let mut seq: HashMap<String, u32> = HashMap::new();
    let mut changed: HashMap<usize, Vec<Paragraph>> = HashMap::new();
    for place in &places {
        let parsed = &doc.stories[place.story];
        let run = &parsed.story.paragraphs[place.paragraph].runs[place.run];
        let field = run.field.as_ref().expect("a field run");
        // SEQ counts every item, updated or not.
        let seq_value = if let WordFieldKind::Seq {
            identifier,
            reset,
            repeat,
        } = &field.kind
        {
            let n = seq.entry(identifier.to_lowercase()).or_insert(0);
            match (reset, repeat) {
                (Some(r), _) => *n = *r,
                (None, true) => {}
                (None, false) => *n += 1,
            }
            Some(*n)
        } else {
            None
        };
        if only_story.is_some_and(|s| s != parsed.self_id)
            || only_offset.is_some_and(|o| o != place.offset)
        {
            continue;
        }
        let host = upd
            .paragraph_pages
            .get(&parsed.self_id)
            .and_then(|m| m.get(&place.paragraph).copied());
        let Some(result) = updated_result(
            upd,
            field,
            host,
            seq_value,
            (parsed.self_id.as_str(), place.paragraph as u32),
        ) else {
            continue;
        };
        if result == run.text {
            continue;
        }
        let paragraphs = changed
            .entry(place.story)
            .or_insert_with(|| parsed.story.paragraphs.clone());
        paragraphs[place.paragraph].runs[place.run].text = result;
    }
    let mut out: Vec<(usize, Vec<Paragraph>)> = changed.into_iter().collect();
    out.sort_by_key(|(i, _)| *i);
    out.into_iter()
        .map(|(i, p)| (doc.stories[i].self_id.clone(), p))
        .collect()
}

/// A field's updated result, or `None` to keep the one it has (an opaque
/// field, a date without a clock, a page-dependent field in a story the
/// layout does not place, such as a master's).
fn updated_result(
    upd: &FieldUpdate,
    field: &WordField,
    host: Option<usize>,
    seq_value: Option<u32>,
    here: (&str, u32),
) -> Option<String> {
    let doc = upd.document;
    match &field.kind {
        WordFieldKind::Date { format, time } => upd
            .now
            .as_ref()
            .map(|now| format_word_date(format.as_deref(), now, *time)),
        WordFieldKind::NumPages => Some(field.format_number(upd.page_labels.len() as u32)),
        WordFieldKind::SectionPages => {
            let section = upd.page_sections.get(host?).copied()?;
            let n = upd.page_sections.iter().filter(|s| **s == section).count();
            Some(field.format_number(n as u32))
        }
        WordFieldKind::Page => {
            let host = host?;
            match field.number_format {
                Some(_) => upd.page_numbers.get(host).map(|n| field.format_number(*n)),
                None => upd.page_labels.get(host).cloned(),
            }
        }
        WordFieldKind::Ref { bookmark } => {
            Some(bookmark_text(doc, bookmark).unwrap_or_else(|| REF_ERROR.to_string()))
        }
        WordFieldKind::PageRef { bookmark, relative } => {
            let Some((story, dest)) = find_bookmark(doc, bookmark) else {
                return Some(PAGEREF_ERROR.to_string());
            };
            let page = upd
                .paragraph_pages
                .get(story)
                .and_then(|m| m.get(&(dest.paragraph as usize)).copied())?;
            Some(page_ref_text(
                field,
                upd.page_labels,
                upd.page_numbers,
                page,
                *relative,
                host.unwrap_or(usize::MAX),
                Some(here),
                (story, dest.paragraph),
            ))
        }
        WordFieldKind::Seq { .. } => seq_value.map(|n| field.format_number(n)),
        WordFieldKind::StyleRef { style, last } => {
            let host = host?;
            let id = style_ref_id(doc, style)?;
            Some(style_ref_on(upd, &id, host, *last).unwrap_or_default())
        }
        WordFieldKind::Opaque => None,
    }
}

/// The text of the paragraph in style `style` that a `STYLEREF` on page
/// `host` shows: the first (the last with `last`) on that page, else the
/// last one before it.
fn style_ref_on(upd: &FieldUpdate, style: &str, host: usize, last: bool) -> Option<String> {
    let mut on_page: Vec<String> = Vec::new();
    let mut before: Option<(usize, String)> = None;
    for s in &upd.document.stories {
        for (pi, p) in s.story.paragraphs.iter().enumerate() {
            if p.paragraph_style.as_deref() != Some(style) {
                continue;
            }
            let Some(page) = upd
                .paragraph_pages
                .get(&s.self_id)
                .and_then(|m| m.get(&pi).copied())
            else {
                continue;
            };
            let text: String = p.runs.iter().map(|r| r.text.as_str()).collect();
            let text = plain(&text).trim_end_matches(['\n', '\r']).to_string();
            if page == host {
                on_page.push(text);
            } else if page < host && before.as_ref().is_none_or(|(b, _)| page >= *b) {
                before = Some((page, text));
            }
        }
    }
    let pick = if last {
        on_page.pop()
    } else {
        on_page.into_iter().next()
    };
    pick.or(before.map(|(_, t)| t))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_ref_reads_relative_positions() {
        let f = WordField::parse(r"PAGEREF bm \p");
        let labels = vec!["1".to_string(), "2".to_string()];
        let numbers = vec![1, 2];
        assert_eq!(
            page_ref_text(&f, &labels, &numbers, 1, true, 0, None, ("s", 0)),
            "on page 2"
        );
        assert_eq!(
            page_ref_text(&f, &labels, &numbers, 0, true, 0, Some(("s", 3)), ("s", 1)),
            "above"
        );
        assert_eq!(
            page_ref_text(&f, &labels, &numbers, 0, true, 0, Some(("s", 0)), ("s", 4)),
            "below"
        );
        let roman = WordField::parse(r"PAGEREF bm \* roman");
        assert_eq!(
            page_ref_text(&roman, &labels, &numbers, 1, false, 0, None, ("s", 0)),
            "ii"
        );
    }
}
