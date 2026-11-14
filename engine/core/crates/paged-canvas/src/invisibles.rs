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

//! Hidden characters (v81, engine ADR 1306): where the composed lines of
//! a page hold their invisibles — spaces, tabs, paragraph returns, forced
//! line breaks, the end of a story and the other characters InDesign's
//! Type ▸ Show Hidden Characters marks.
//!
//! A read of the build the canvas already holds: the lines' per-cluster
//! positions ([`paged_renderer::LineLayout`], the ones the caret and the
//! hit test use) and the story text they index. The editor draws the
//! marks as an overlay, as it draws every other editing aid; the page's
//! raster, its display list and its digest never carry them.

use std::collections::HashMap;

use paged_renderer::{CellAddr, LineLayout, PageId};
use serde::{Deserialize, Serialize};
use tsify_next::Tsify;

use crate::model::CanvasModel;

/// What an invisible is. InDesign's marks for them: `·` a space, `°` a
/// nonbreaking space, `»` a tab, `¶` a paragraph return, `¬` a forced
/// line break, `#` the end of a story, and a break character's own glyph.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi)]
#[serde(rename_all = "camelCase")]
pub enum HiddenCharacterKind {
    /// U+0020.
    Space,
    /// U+00A0 or U+202F (InDesign's fixed-width one).
    NonBreakingSpace,
    /// A fixed-width space: en, em, third, quarter, sixth, figure,
    /// punctuation, thin, hair, flush (U+2000–U+200A, U+3000).
    FixedSpace,
    /// U+0009.
    Tab,
    /// U+2028 (Shift+Enter): the line breaks, the paragraph goes on.
    ForcedLineBreak,
    /// U+200B: a place the line may break without a hyphen.
    DiscretionaryLineBreak,
    /// U+FFFC: an anchored object's place in the text.
    AnchoredObject,
    /// The end of a paragraph.
    ParagraphEnd,
    /// A paragraph end whose next paragraph starts in the next column.
    ColumnBreak,
    /// … in the next frame.
    FrameBreak,
    /// … on the next page.
    PageBreak,
    /// … on the next odd page.
    OddPageBreak,
    /// … on the next even page.
    EvenPageBreak,
    /// The end of the story (of a table cell's text, in a cell).
    StoryEnd,
}

/// One invisible on a line.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi)]
#[serde(rename_all = "camelCase")]
pub struct HiddenCharacter {
    pub kind: HiddenCharacterKind,
    /// The character's left edge on the line, page-local pt, upright
    /// (before the line's `turn`). A mark that ends a line or a paragraph
    /// stands where the line's text ends.
    pub x: f32,
    /// The width the character takes on the line, pt (0 for what takes
    /// none: a return, a break).
    pub width: f32,
}

/// The invisibles of one composed line.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi, missing_as_null)]
#[serde(rename_all = "camelCase")]
pub struct HiddenCharacterLine {
    pub story_id: String,
    /// The text frame the line is set in, when it has an id.
    pub frame_id: Option<String>,
    /// The table cell the line belongs to, for a cell's text.
    pub cell: Option<crate::selection::TextCellAddr>,
    /// The baseline, page-local pt, upright.
    pub baseline: f32,
    /// The size to draw the marks at, pt: the line's text size, from its
    /// leading (auto leading is 120 % of the size).
    pub size: f32,
    /// How the page turns the line (a turned frame, a vertical story):
    /// `[a, b, c, d, e, f]` mapping its upright positions onto the page;
    /// absent for an upright line.
    pub turn: Option<[f32; 6]>,
    pub marks: Vec<HiddenCharacter>,
}

/// The invisibles of one page, in the order its lines were composed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi)]
#[serde(rename_all = "camelCase")]
pub struct PageHiddenCharacters {
    pub page_id: PageId,
    pub lines: Vec<HiddenCharacterLine>,
}

/// The kind of the invisible `c`, or `None` for a character that prints.
pub fn hidden_character_kind(c: char) -> Option<HiddenCharacterKind> {
    use HiddenCharacterKind as K;
    Some(match c {
        ' ' => K::Space,
        '\u{00A0}' | '\u{202F}' => K::NonBreakingSpace,
        '\u{2000}'..='\u{200A}' | '\u{3000}' => K::FixedSpace,
        '\t' => K::Tab,
        '\u{2028}' => K::ForcedLineBreak,
        '\u{200B}' => K::DiscretionaryLineBreak,
        '\u{FFFC}' => K::AnchoredObject,
        _ => return None,
    })
}

/// A stream's text (paragraphs joined by the synthetic `\n`, as the caret
/// addresses it) and where its model paragraphs start in it. A model
/// paragraph may hold returns of its own (a `<Br/>` inside one range is a
/// `\n` in its run's text), so a return is found in the text, not by the
/// paragraph index.
struct Stream {
    text: String,
    /// The byte each model paragraph after the first starts at, with the
    /// mark the return before it stands for.
    starts: Vec<(usize, HiddenCharacterKind)>,
}

impl Stream {
    fn of(paragraphs: &[paged_model::Paragraph]) -> Stream {
        use paged_model::StartParagraph as S;
        use HiddenCharacterKind as K;
        let mut text = String::new();
        let mut starts = Vec::with_capacity(paragraphs.len());
        for (i, para) in paragraphs.iter().enumerate() {
            if i > 0 {
                text.push('\n');
                // A break character is the return before a paragraph that
                // starts elsewhere (IDML writes it as that paragraph's own
                // `StartParagraph`).
                let kind = match para.start_paragraph {
                    Some(S::NextColumn) => K::ColumnBreak,
                    Some(S::NextFrame) => K::FrameBreak,
                    Some(S::NextPage) => K::PageBreak,
                    Some(S::NextOddPage) => K::OddPageBreak,
                    Some(S::NextEvenPage) => K::EvenPageBreak,
                    _ => K::ParagraphEnd,
                };
                starts.push((text.len(), kind));
            }
            for run in &para.runs {
                text.push_str(&run.text);
            }
        }
        Stream { text, starts }
    }

    /// The mark of the paragraph end at byte `at`: the return there, or
    /// the story's end past the last byte.
    fn end_at(&self, at: usize) -> HiddenCharacterKind {
        if at >= self.text.len() {
            return HiddenCharacterKind::StoryEnd;
        }
        match self.starts.binary_search_by_key(&(at + 1), |(b, _)| *b) {
            Ok(i) => self.starts[i].1,
            Err(_) => HiddenCharacterKind::ParagraphEnd,
        }
    }
}

impl CanvasModel {
    /// v81 (engine ADR 1306) — the hidden characters of `page_ids`'
    /// composed lines (the visible pages: the overlay asks for no more).
    /// An unknown page id is left out.
    pub fn hidden_characters(&self, page_ids: &[PageId]) -> Vec<PageHiddenCharacters> {
        let mut streams: HashMap<(String, Option<CellAddr>), Option<Stream>> = HashMap::new();
        let mut out = Vec::new();
        for page_id in page_ids {
            let Some(page) = self.page(page_id) else {
                continue;
            };
            let mut lines = Vec::new();
            for line in &page.story_layout {
                let key = (line.story_id.clone(), line.cell.clone());
                let stream = streams.entry(key).or_insert_with(|| {
                    let addr = line.cell.as_ref().map(wire_cell);
                    self.stream_paragraphs(&line.story_id, addr.as_ref())
                        .map(Stream::of)
                });
                let Some(stream) = stream.as_ref() else {
                    continue;
                };
                if let Some(marked) = self.line_marks(line, stream) {
                    lines.push(marked);
                }
            }
            out.push(PageHiddenCharacters {
                page_id: page_id.clone(),
                lines,
            });
        }
        out
    }

    fn line_marks(&self, line: &LineLayout, stream: &Stream) -> Option<HiddenCharacterLine> {
        let built = self.built();
        let start = match &line.cell {
            None => crate::hit::paragraph_byte_offset(built, &line.story_id, line.paragraph_idx),
            Some(addr) => crate::hit::cell_paragraph_byte_offset(
                built,
                &line.story_id,
                addr,
                line.paragraph_idx,
            ),
        } as usize;
        let text = stream.text.as_str();
        let at = |b: u32| start + b as usize;
        let (lo, hi) = (at(line.byte_range.start), at(line.byte_range.end));
        let (lo, hi) = (lo.min(text.len()), hi.min(text.len()));
        // Where the line's text ends: past its last cluster in story
        // order, on the side the text runs to.
        let end_x = {
            let first = line.clusters.iter().min_by_key(|c| c.byte);
            let last = line.clusters.iter().max_by_key(|c| c.byte);
            match (first, last) {
                (Some(f), Some(l)) if l.x_pt < f.x_pt => l.x_pt,
                (_, Some(l)) => l.x_pt + l.advance_pt,
                _ => return None,
            }
        };
        let cluster_at = |byte: usize| {
            line.clusters
                .iter()
                .find(|c| at(c.byte) == byte)
                .map(|c| (c.x_pt, c.advance_pt))
        };
        let mut marks = Vec::new();
        let end_mark = |kind| HiddenCharacter {
            kind,
            x: end_x,
            width: 0.0,
        };
        // Whether the line's own range ends in what ends a line.
        let mut ended = false;
        if let Some(slice) = text.get(lo..hi) {
            for (offset, c) in slice.char_indices() {
                let last = lo + offset + c.len_utf8() == hi;
                if c == '\n' {
                    // A return inside the line's range ends it.
                    marks.push(end_mark(stream.end_at(lo + offset)));
                    ended |= last;
                    continue;
                }
                let Some(kind) = hidden_character_kind(c) else {
                    continue;
                };
                if kind == HiddenCharacterKind::ForcedLineBreak {
                    ended |= last;
                }
                match (cluster_at(lo + offset), kind) {
                    (Some((x, width)), _) => marks.push(HiddenCharacter { kind, x, width }),
                    // A break the composer set no glyph for stands where
                    // the line's text ends.
                    (None, HiddenCharacterKind::ForcedLineBreak) => marks.push(end_mark(kind)),
                    (None, _) => {}
                }
            }
        }
        // What ends the line just past its range: a forced line break, a
        // paragraph's return (or the break it stands for), the story's end.
        if !ended {
            // `get`: a range that ends off a character boundary marks nothing
            // rather than panicking.
            match text.get(hi..).map(|rest| rest.chars().next()) {
                Some(Some('\u{2028}')) => {
                    marks.push(end_mark(HiddenCharacterKind::ForcedLineBreak))
                }
                Some(Some('\n')) | Some(None) => marks.push(end_mark(stream.end_at(hi))),
                _ => {}
            }
        }
        if marks.is_empty() {
            return None;
        }
        Some(HiddenCharacterLine {
            story_id: line.story_id.clone(),
            frame_id: line.frame_id.clone(),
            cell: line.cell.as_ref().map(wire_cell),
            baseline: line.baseline_y_pt,
            size: ((line.ascent_pt + line.descent_pt) / 1.2).max(1.0),
            turn: line.turn,
            marks,
        })
    }
}

fn wire_cell(addr: &CellAddr) -> crate::selection::TextCellAddr {
    crate::selection::TextCellAddr {
        table_id: addr.table_id.clone(),
        row: addr.row,
        col: addr.col,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_invisibles_are_classed_as_indesign_marks_them() {
        use HiddenCharacterKind as K;
        assert_eq!(hidden_character_kind(' '), Some(K::Space));
        assert_eq!(hidden_character_kind('\u{a0}'), Some(K::NonBreakingSpace));
        assert_eq!(hidden_character_kind('\u{202f}'), Some(K::NonBreakingSpace));
        assert_eq!(hidden_character_kind('\u{2003}'), Some(K::FixedSpace));
        assert_eq!(hidden_character_kind('\t'), Some(K::Tab));
        assert_eq!(hidden_character_kind('\u{2028}'), Some(K::ForcedLineBreak));
        assert_eq!(hidden_character_kind('a'), None);
        assert_eq!(hidden_character_kind('\u{e018}'), None);
    }

    #[test]
    fn a_paragraph_ends_in_the_break_its_successor_starts_with() {
        use paged_model::{Paragraph, StartParagraph as S};
        use HiddenCharacterKind as K;
        let starting = |start: Option<S>| Paragraph {
            start_paragraph: start,
            ..Paragraph::default()
        };
        let stream = Stream::of(&[
            starting(None),
            starting(Some(S::NextColumn)),
            starting(Some(S::NextFrame)),
            starting(Some(S::NextPage)),
            starting(Some(S::Anywhere)),
            starting(None),
        ]);
        // Paragraphs joined by the synthetic separator the caret counts.
        assert_eq!(stream.text, "\n\n\n\n\n");
        let ends: Vec<K> = (0..=5).map(|at| stream.end_at(at)).collect();
        assert_eq!(
            ends,
            [
                K::ColumnBreak,
                K::FrameBreak,
                K::PageBreak,
                K::ParagraphEnd,
                K::ParagraphEnd,
                K::StoryEnd
            ]
        );
    }

    #[test]
    fn a_return_inside_a_paragraphs_text_is_a_paragraph_end() {
        use paged_model::{CharacterRun, Paragraph};
        use HiddenCharacterKind as K;
        let para = |text: &str| Paragraph {
            runs: vec![CharacterRun {
                text: text.into(),
                ..CharacterRun::default()
            }],
            ..Paragraph::default()
        };
        // One range holding two returns (`<Br/>` inside it), then a second
        // paragraph.
        let stream = Stream::of(&[para("a\nb\nc"), para("d")]);
        assert_eq!(stream.text, "a\nb\nc\nd");
        assert_eq!(stream.end_at(1), K::ParagraphEnd);
        assert_eq!(stream.end_at(3), K::ParagraphEnd);
        assert_eq!(stream.end_at(5), K::ParagraphEnd);
        assert_eq!(stream.end_at(7), K::StoryEnd);
    }

    #[test]
    fn the_wire_spells_a_line_in_camel_case() {
        let line = HiddenCharacterLine {
            story_id: "u1".into(),
            frame_id: None,
            cell: None,
            baseline: 10.0,
            size: 12.0,
            turn: None,
            marks: vec![HiddenCharacter {
                kind: HiddenCharacterKind::ParagraphEnd,
                x: 4.0,
                width: 0.0,
            }],
        };
        let json = serde_json::to_string(&line).unwrap();
        assert!(json.contains(r#""storyId":"u1""#), "{json}");
        assert!(json.contains(r#""kind":"paragraphEnd""#), "{json}");
    }
}
