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

//! Word's document structure on the native model (doc ADRs 611 and 612):
//! the masters a section's pages take (its headers and footers), the Word
//! fields the engine keeps live, and the tables of contents in the body.
//!
//! All of it is pure: what the skeleton writes and the bundle pours is
//! decided here, from `docx-core` alone.

use docx_core::{
    Block, DocxDocument, HeaderFooterKind, HeaderFooterSet, Run, Section, SectionKind,
};

use crate::ir::{
    LoweredField, LoweredMaster, LoweredMasterFrame, LoweredSectionMasters, LoweredToc,
};
use crate::sections::SectionPlacement;

/// Word's header and footer distance when a section names none (0.5 in).
const DEFAULT_DISTANCE_TWIPS: i32 = 720;
/// The least height a header or footer frame gets, in points: room for a
/// line of 11 pt text when the margin leaves less.
const MIN_FRAME_PT: f32 = 18.0;

fn pt(twips: i32) -> f32 {
    twips as f32 / 20.0
}

/// The id of master `n` and the ids of its header and footer frame and
/// story (the skeleton writes them, the bundle pours them, save-back reads
/// them back).
pub fn master_id(n: usize) -> String {
    format!("docx_m{n}")
}
pub fn master_story_id(n: usize, footer: bool) -> String {
    format!("docx_m{n}_{}", if footer { "f" } else { "h" })
}
pub fn master_frame_id(n: usize, footer: bool) -> String {
    format!("docx_m{n}_{}f", if footer { "f" } else { "h" })
}

/// What makes two masters the same: the parts they show and the page they
/// are drawn for.
#[derive(PartialEq)]
struct MasterKey {
    header: Option<usize>,
    footer: Option<usize>,
    geometry: [i32; 8],
}

fn geometry(s: &Section) -> [i32; 8] {
    [
        s.page_width,
        s.page_height,
        s.margin_top,
        s.margin_bottom,
        s.margin_left,
        s.margin_right,
        s.header_distance.unwrap_or(DEFAULT_DISTANCE_TWIPS),
        s.footer_distance.unwrap_or(DEFAULT_DISTANCE_TWIPS),
    ]
}

/// The header frame of a section's page: from the header distance down to
/// the top margin, at the margin box's width. Word moves the body down
/// when a header outgrows that room; the frame keeps at least
/// [`MIN_FRAME_PT`].
pub fn header_bounds(s: &Section) -> [f32; 4] {
    let top = pt(s.header_distance.unwrap_or(DEFAULT_DISTANCE_TWIPS));
    let bottom = pt(s.margin_top).max(top + MIN_FRAME_PT);
    [
        top,
        pt(s.margin_left),
        bottom,
        pt(s.page_width - s.margin_right),
    ]
}

/// The footer frame: from the bottom margin to the footer distance above
/// the page's foot, its text set on the frame's foot.
pub fn footer_bounds(s: &Section) -> [f32; 4] {
    let bottom = pt(s.page_height - s.footer_distance.unwrap_or(DEFAULT_DISTANCE_TWIPS));
    let top = pt(s.page_height - s.margin_bottom).min(bottom - MIN_FRAME_PT);
    [
        top,
        pt(s.margin_left),
        bottom,
        pt(s.page_width - s.margin_right),
    ]
}

fn kind_word(kind: HeaderFooterKind) -> &'static str {
    match kind {
        HeaderFooterKind::Default => "default",
        HeaderFooterKind::First => "first",
        HeaderFooterKind::Even => "even",
    }
}

fn kind_name(kind: HeaderFooterKind) -> &'static str {
    match kind {
        HeaderFooterKind::Default => "",
        HeaderFooterKind::First => " First Page",
        HeaderFooterKind::Even => " Even Page",
    }
}

/// The part a set shows on a page of `kind`. Word's rule (ECMA-376
/// §17.10.5, measured in `fixtures/headers.word.json`): a first page with
/// `titlePg` shows the `first` part or a blank one; an even page with
/// `evenAndOddHeaders` the `even` part or a blank one; every other page
/// the `default` part.
fn part_for(set: &HeaderFooterSet, kind: HeaderFooterKind) -> Option<usize> {
    set.get(kind).map(|r| r.index)
}

/// The masters of a document (doc ADR 611), and for every section the
/// masters its story's pages take (`None` for a section that joins the
/// story before it, and for every section when the document has no header
/// or footer at all). One master per distinct (header part, footer part,
/// page) a section shows; a section that links to the previous one shows
/// the same parts and so takes the same master.
pub fn plan_masters(
    doc: &DocxDocument,
    placements: &[SectionPlacement],
) -> (Vec<LoweredMaster>, Vec<Option<LoweredSectionMasters>>) {
    let mut masters: Vec<LoweredMaster> = Vec::new();
    let mut keys: Vec<MasterKey> = Vec::new();
    let mut per_section = vec![None; doc.sections.len()];
    if doc.headers_footers.is_empty() {
        return (masters, per_section);
    }
    for (k, s) in doc.sections.iter().enumerate() {
        let opens_story =
            k == 0 || placements.get(k).map(|p| p.story) != placements.get(k - 1).map(|p| p.story);
        if !opens_story {
            continue;
        }
        let mut take = |kind: HeaderFooterKind| -> String {
            let key = MasterKey {
                header: part_for(&s.headers, kind),
                footer: part_for(&s.footers, kind),
                geometry: geometry(s),
            };
            if let Some(i) = keys.iter().position(|q| *q == key) {
                return masters[i].id.clone();
            }
            let n = masters.len();
            let frame = |part: Option<usize>, footer: bool| {
                part.map(|part| LoweredMasterFrame {
                    part,
                    story_id: master_story_id(n, footer),
                    frame_id: master_frame_id(n, footer),
                    bounds: if footer {
                        footer_bounds(s)
                    } else {
                        header_bounds(s)
                    },
                    bottom_aligned: footer,
                })
            };
            masters.push(LoweredMaster {
                id: master_id(n),
                name: format!("Section {}{}", k + 1, kind_name(kind)),
                section: k,
                kind: kind_word(kind).into(),
                page_width_pt: pt(s.page_width),
                page_height_pt: pt(s.page_height),
                header: frame(key.header, false),
                footer: frame(key.footer, true),
            });
            keys.push(key);
            masters[n].id.clone()
        };
        let master = take(HeaderFooterKind::Default);
        let first_master = s.title_page.then(|| take(HeaderFooterKind::First));
        let even_master = doc
            .even_and_odd_headers
            .then(|| take(HeaderFooterKind::Even));
        per_section[k] = Some(LoweredSectionMasters {
            master: Some(master),
            first_master,
            even_master,
        });
    }
    (masters, per_section)
}

/// The grow rule's section start for section `k` (engine ADR 1022): an
/// odd- or even-page section that opens a story. A next-page section needs
/// none (its story opens on a page of its own), and the first section has
/// nothing before it.
pub fn section_start(
    doc: &DocxDocument,
    placements: &[SectionPlacement],
    k: usize,
) -> Option<String> {
    let opens_story =
        k > 0 && placements.get(k).map(|p| p.story) != placements.get(k - 1).map(|p| p.story);
    if !opens_story {
        return None;
    }
    match doc.sections.get(k)?.kind {
        SectionKind::OddPage => Some("oddPage".into()),
        SectionKind::EvenPage => Some("evenPage".into()),
        _ => None,
    }
}

/// The fields the lowering leaves to other paths: a hyperlink (a native
/// link), a mail-merge field (the template fields' object model), a table
/// of contents (its entries are poured, [`find_tocs`]).
const NOT_ENGINE_FIELDS: &[&str] = &["HYPERLINK", "MERGEFIELD", "TOC"];

/// The engine Word field a result run belongs to (doc ADR 612), when the
/// engine can hold it: a field with an instruction, whose result runs hold
/// text only (no picture, break or positional tab).
pub fn word_field(r: &Run) -> Option<LoweredField> {
    let name = r.field.as_deref()?;
    if NOT_ENGINE_FIELDS.contains(&name) || r.merge_field.is_some() {
        return None;
    }
    let code = r.field_code.as_deref()?.trim();
    if code.is_empty()
        || r.text.is_empty()
        || !r.images.is_empty()
        || !r.breaks.is_empty()
        || !r.ptabs.is_empty()
        || r.note_ref.is_some()
    {
        return None;
    }
    Some(LoweredField {
        code: code.to_string(),
        seq: r.field_seq.unwrap_or(0),
    })
}

/// The outline levels a TOC instruction lists (`\o "1-3"`), 1-based and
/// inclusive; Word's default `1-9` when it names none.
pub fn toc_levels(instruction: &str) -> (u8, u8) {
    let tokens: Vec<&str> = instruction.split_whitespace().collect();
    for (i, t) in tokens.iter().enumerate() {
        if t.eq_ignore_ascii_case("\\o") {
            if let Some(arg) = tokens.get(i + 1) {
                let arg = arg.trim_matches('"');
                let mut parts = arg.split('-');
                let a = parts.next().and_then(|x| x.parse::<u8>().ok());
                let b = parts.next().and_then(|x| x.parse::<u8>().ok()).or(a);
                if let (Some(a), Some(b)) = (a, b) {
                    return (a.clamp(1, 9), b.clamp(a.clamp(1, 9), 9));
                }
            }
        }
    }
    (1, 9)
}

/// Whether a Word paragraph style is one of Word's TOC entry styles
/// (`TOC1` … `TOC9`, named `toc 1` … `toc 9`).
pub fn is_toc_entry_style(style_id: &str, name: Option<&str>) -> bool {
    let id = style_id.to_ascii_lowercase();
    let named = name.map(str::to_ascii_lowercase);
    let entry = |s: &str| {
        s.strip_prefix("toc")
            .map(str::trim)
            .is_some_and(|n| n.len() == 1 && n.as_bytes()[0].is_ascii_digit())
    };
    entry(&id) || named.as_deref().is_some_and(entry)
}

/// The tables of contents in the body (doc ADR 612): a paragraph where a
/// `TOC` field begins, and the run of TOC-entry paragraphs from it.
pub fn find_tocs(doc: &DocxDocument) -> Vec<LoweredToc> {
    let entry = |b: &Block| match b {
        Block::Paragraph(p) => p.style_id.as_deref().is_some_and(|id| {
            let name = doc
                .styles
                .styles
                .iter()
                .find(|s| s.style_id == id)
                .and_then(|s| s.name.as_deref());
            is_toc_entry_style(id, name)
        }),
        Block::Table(_) => false,
    };
    let mut out = Vec::new();
    let mut idx = 0;
    while idx < doc.body.len() {
        let Block::Paragraph(p) = &doc.body[idx] else {
            idx += 1;
            continue;
        };
        let Some(instruction) = p.toc_field.as_ref() else {
            idx += 1;
            continue;
        };
        let mut end = idx + 1;
        while end < doc.body.len() && entry(&doc.body[end]) {
            end += 1;
        }
        out.push(LoweredToc {
            instruction: instruction.clone(),
            first_block: idx,
            end_block: end,
            levels: toc_levels(instruction),
        });
        idx = end;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn toc_levels_read_the_outline_switch() {
        assert_eq!(toc_levels(r#"TOC \o "1-3" \h \z \u"#), (1, 3));
        assert_eq!(toc_levels(r#"TOC \o "2-2""#), (2, 2));
        assert_eq!(toc_levels(r#"TOC \h"#), (1, 9));
    }

    #[test]
    fn toc_entry_styles_are_words_by_id_or_name() {
        assert!(is_toc_entry_style("TOC1", None));
        assert!(is_toc_entry_style("Inhaltsverzeichnis1", Some("toc 1")));
        assert!(!is_toc_entry_style("TOCHeading", Some("TOC Heading")));
        assert!(!is_toc_entry_style("Normal", None));
    }

    #[test]
    fn a_field_with_text_is_kept_live_but_not_a_link_or_merge_field() {
        let run = |field: &str, code: &str| Run {
            text: "3".into(),
            field: Some(field.into()),
            field_code: Some(code.into()),
            field_seq: Some(1),
            ..Run::default()
        };
        assert_eq!(
            word_field(&run("PAGE", " PAGE \\* MERGEFORMAT ")),
            Some(LoweredField {
                code: "PAGE \\* MERGEFORMAT".into(),
                seq: 1
            })
        );
        assert_eq!(word_field(&run("HYPERLINK", "HYPERLINK \"x\"")), None);
        assert_eq!(word_field(&run("TOC", "TOC \\o")), None);
        let mut empty = run("PAGE", "PAGE");
        empty.text.clear();
        assert_eq!(word_field(&empty), None);
    }
}
