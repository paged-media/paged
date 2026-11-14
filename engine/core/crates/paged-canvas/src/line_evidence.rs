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

//! The Typography Debugger's evidence (v82, engine ADR 1308): for every
//! composed line of a story, what the composer had and what it decided —
//! the measure, the natural width, the adjustment ratio, the word and
//! letter spacing the line was set with, why it broke where it did, the
//! hyphenation points the dictionary offered, and the baseline grid.
//!
//! The record of each line is the build's own (`LineLayout::composition`,
//! kept by the renderer as it sets the line); this module reads it with
//! the story's text, and measures the spacing from the line's glyph
//! positions. Nothing is recomposed for a read.
//!
//! A preview (`RequestLineEvidence.preview`) applies one write to a copy
//! of the document and builds the copy: the evidence is the copy's, and
//! the document, its build, its undo history and its revision are
//! untouched. Applying the change is an ordinary write, one undo step.

use paged_model::Paragraph;
use paged_renderer::{BuiltDocument, LineComposer, LineLayout, PageId};
use paged_scene::Document;
use serde::{Deserialize, Serialize};
use tsify_next::Tsify;

use crate::channel::Mutation;
use crate::model::CanvasModel;

/// Why a line ends where it does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi)]
#[serde(rename_all = "camelCase")]
pub enum BreakKind {
    /// At a word space: the next word did not fit.
    WordSpace,
    /// At a hyphenation point of the dictionary; the composer added the
    /// hyphen.
    Hyphen,
    /// At a discretionary hyphen the text carries (U+00AD).
    DiscretionaryHyphen,
    /// After a hyphen the text has (`two-` / `way`).
    HardHyphen,
    /// At a forced line break (U+2028, Shift+Return).
    ForcedLineBreak,
    /// The paragraph ends.
    ParagraphEnd,
    /// The story ends.
    StoryEnd,
    /// Where nothing allowed a break: the line was cut where it filled
    /// (a word longer than the measure, a run set `NoBreak`).
    Emergency,
}

/// How tightly a line is set, against the paragraph's word spacing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi)]
#[serde(rename_all = "camelCase")]
pub enum Tightness {
    /// Its spaces are below the minimum word spacing (or its text is
    /// wider than the measure).
    VeryTight,
    /// Closer to the minimum than to the desired spacing.
    Tight,
    Normal,
    /// Closer to the maximum than to the desired spacing.
    Loose,
    /// Its spaces are above the maximum word spacing.
    VeryLoose,
}

/// The hyphenation points around a break.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi, missing_as_null)]
#[serde(rename_all = "camelCase")]
pub struct HyphenationEvidence {
    /// The word at the break: the one broken, or the one that went to the
    /// next line whole.
    pub word: String,
    /// Its first character (story character offset).
    pub word_start: u32,
    /// Where the dictionary allowed a hyphen under the paragraph's limits
    /// (story character offsets of the character after the break). A
    /// word with discretionary hyphens offers those alone.
    pub points: Vec<u32>,
    /// The point the line broke at; none when the word went whole.
    pub used: Option<u32>,
    /// The paragraph hyphenates (its own setting); discretionary hyphens
    /// break either way.
    pub hyphenation_on: bool,
    /// Why the word offers no point, when it offers none: `short`,
    /// `capitalized`, `lastWord`, `noLanguage`, `off`, `noPattern`.
    pub reason: Option<String>,
}

/// One composed line.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi, missing_as_null)]
#[serde(rename_all = "camelCase")]
pub struct LineEvidence {
    pub page_id: PageId,
    pub frame_id: Option<String>,
    /// Paragraph (0-based) and line within it.
    pub paragraph: u32,
    pub line: u32,
    /// The line's characters, story character offsets `[start, end)`.
    pub start: u32,
    pub end: u32,
    /// The same in the editor's caret units (UTF-8 bytes, one separator
    /// per paragraph), as a content selection counts them.
    pub caret_start: u32,
    pub caret_end: u32,
    pub text: String,
    /// Page-local pt: the baseline, and the line's extent.
    pub baseline: f32,
    pub left: f32,
    pub right: f32,
    pub top: f32,
    pub bottom: f32,
    /// The measure the line was composed into, pt.
    pub available: f32,
    /// Its width at natural spacing, pt.
    pub natural: f32,
    /// The breaker's adjustment ratio (0 natural, above 0 stretched,
    /// below 0 shrunk; its scale is the breaker's own); 0 for a ragged
    /// line. The spacing below is the comparable measure.
    pub ratio: f32,
    /// The line's word spaces as set, in % of the font's space (mean,
    /// smallest, largest), the scale of the paragraph's word spacing
    /// settings; none on a line without one.
    pub word_spacing: Option<f32>,
    pub word_spacing_min: Option<f32>,
    pub word_spacing_max: Option<f32>,
    /// The space added between letters, mean pt per letter (justification
    /// letter-spacing a line, a single word set to the measure).
    pub letter_spacing: f32,
    pub break_kind: BreakKind,
    /// The next line is set in another frame.
    pub frame_end: bool,
    /// The story continues past this line and is not placed (overset).
    pub overset_after: bool,
    pub hyphenation: Option<HyphenationEvidence>,
    pub tightness: Tightness,
    /// What is out of the paragraph's bounds: `wordSpacingAboveMaximum`,
    /// `wordSpacingBelowMinimum`, `letterSpacing`, `overfull`.
    pub outliers: Vec<String>,
    /// `paragraph`, `singleLine` or `wordFirstFit`.
    pub composer: String,
    pub justified: bool,
    /// The line aligns to the baseline grid, moved this much (pt) to
    /// stand on it; none when it does not align.
    pub grid_shift: Option<f32>,
}

/// The settings a paragraph's lines were composed with.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi, missing_as_null)]
#[serde(rename_all = "camelCase")]
pub struct ParagraphComposition {
    pub paragraph: u32,
    /// `paragraph`, `singleLine` or `wordFirstFit`.
    pub composer: String,
    /// IDML's `Justification` (`LeftAlign`, `LeftJustified`, …).
    pub justification: String,
    pub hyphenation: bool,
    pub hyphenation_zone: Option<f32>,
    pub hyphenate_after_first: u32,
    pub hyphenate_before_last: u32,
    pub hyphenate_words_longer_than: u32,
    pub hyphenate_capitalized_words: bool,
    pub hyphenate_last_word: bool,
    /// Hyphens in a row; 0 for no limit.
    pub hyphenate_ladder_limit: u32,
    /// The dictionary's language; none when the paragraph is not
    /// hyphenated by one (`[No Language]` or one without patterns).
    pub language: Option<String>,
    /// Minimum, desired and maximum word spacing, %.
    pub word_spacing: [f32; 3],
    /// Minimum, desired and maximum letter spacing, %.
    pub letter_spacing: [f32; 3],
    /// Minimum, desired and maximum glyph scaling, %.
    pub glyph_scaling: [f32; 3],
    /// The baseline grid alignment (`None`, `AlignBaseline`, …).
    pub grid_alignment: String,
}

/// The story's text past its last frame.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi, missing_as_null)]
#[serde(rename_all = "camelCase")]
pub struct OversetEvidence {
    /// The first character not placed (story character offset).
    pub from: u32,
    /// How many characters are not placed.
    pub characters: u32,
}

/// The answer to `RequestLineEvidence`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi, missing_as_null)]
#[serde(rename_all = "camelCase")]
pub struct LineEvidenceReport {
    pub story_id: String,
    /// The story exists.
    pub found: bool,
    /// The evidence is a preview's: the document with `preview` applied
    /// to a copy. The document itself is unchanged.
    pub preview: bool,
    /// Why a preview could not be made (`unsupported`, a refusal); the
    /// lines are then the document's own.
    pub refused: Option<String>,
    pub lines: Vec<LineEvidence>,
    pub paragraphs: Vec<ParagraphComposition>,
    pub overset: Option<OversetEvidence>,
    /// The document revision the answer holds for (engine ADR 1301); a
    /// preview's holds for the document it was made from.
    pub revision: u64,
}

/// What a request asks for: the story, optionally one frame's lines and a
/// character range, and an optional write to preview.
#[derive(Debug, Clone, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi, missing_as_null)]
#[serde(rename_all = "camelCase")]
pub struct LineEvidenceQuery {
    pub story: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[tsify(optional)]
    pub frame: Option<String>,
    /// Story character offsets `[start, end)`: only the lines that touch it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[tsify(optional)]
    pub range: Option<(u32, u32)>,
    /// A write to preview (a property of a story range, a paragraph or a
    /// style): applied to a copy, never to the document.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[tsify(optional)]
    pub preview: Option<Mutation>,
}

/// The paragraph texts of a story (runs joined), as `LineLayout` bytes
/// index them, and the story character offset each paragraph starts at.
struct StoryText {
    paragraphs: Vec<String>,
    starts: Vec<u32>,
    total: u32,
}

impl StoryText {
    fn of(paragraphs: &[Paragraph]) -> Self {
        let mut texts = Vec::with_capacity(paragraphs.len());
        let mut starts = Vec::with_capacity(paragraphs.len());
        let mut at = 0u32;
        for p in paragraphs {
            let text: String = p.runs.iter().map(|r| r.text.as_str()).collect();
            starts.push(at);
            at += text.chars().count() as u32;
            texts.push(text);
        }
        Self {
            paragraphs: texts,
            starts,
            total: at,
        }
    }

    /// The story character offset of paragraph-local byte `byte`.
    fn char_at(&self, paragraph: u32, byte: u32) -> u32 {
        let Some(text) = self.paragraphs.get(paragraph as usize) else {
            return self.total;
        };
        let mut b = (byte as usize).min(text.len());
        while !text.is_char_boundary(b) {
            b -= 1;
        }
        self.starts[paragraph as usize] + text[..b].chars().count() as u32
    }

    fn char_of(&self, paragraph: u32, byte: u32) -> Option<char> {
        self.paragraphs
            .get(paragraph as usize)?
            .get(byte as usize..)?
            .chars()
            .next()
    }

    fn char_before(&self, paragraph: u32, byte: u32) -> Option<char> {
        self.paragraphs
            .get(paragraph as usize)?
            .get(..byte as usize)?
            .chars()
            .next_back()
    }
}

fn is_space(c: char) -> bool {
    matches!(
        c,
        ' ' | '\u{00A0}' | '\u{202F}' | '\u{2000}'..='\u{200A}' | '\u{3000}'
    )
}

fn composer_name(c: LineComposer) -> &'static str {
    match c {
        LineComposer::Paragraph => "paragraph",
        LineComposer::SingleLine => "singleLine",
        LineComposer::WordFirstFit => "wordFirstFit",
    }
}

fn enum_name<T: Serialize>(v: &T) -> String {
    match serde_json::to_value(v) {
        Ok(serde_json::Value::String(s)) => s,
        Ok(other) => other.to_string(),
        Err(_) => String::new(),
    }
}

/// The settings of paragraph `pi`, as the composer read them.
fn paragraph_composition(doc: &Document, pi: u32, para: &Paragraph) -> ParagraphComposition {
    let resolved = doc.resolved_paragraph_attrs(para);
    let runs: Vec<paged_scene::ResolvedRunAttrs> = para
        .runs
        .iter()
        .map(|r| doc.resolved_run_attrs(para, r))
        .collect();
    let limits = paged_renderer::hyphenation_limits(&resolved);
    let language = paged_renderer::hyphenation_language(&resolved, &runs);
    let hyphenator = paged_text::Hyphenators::new().resolve(language).copied();
    let composer = match &resolved.composer {
        Some(c) if c.is_word_first_fit() => "wordFirstFit",
        Some(c) if c.is_single_line() => "singleLine",
        _ => "paragraph",
    };
    let desired_ws = resolved.desired_word_spacing.unwrap_or(100.0);
    let desired_ls = resolved.desired_letter_spacing.unwrap_or(0.0);
    let desired_gs = resolved.desired_glyph_scaling.unwrap_or(100.0);
    ParagraphComposition {
        paragraph: pi,
        composer: composer.into(),
        justification: resolved
            .justification
            .as_ref()
            .map(enum_name)
            .unwrap_or_else(|| "LeftAlign".into()),
        hyphenation: resolved.hyphenation.unwrap_or(true),
        hyphenation_zone: resolved.hyphenation_zone,
        hyphenate_after_first: limits.after_first as u32,
        hyphenate_before_last: limits.before_last as u32,
        hyphenate_words_longer_than: limits.words_longer_than as u32,
        hyphenate_capitalized_words: limits.capitalized_words,
        hyphenate_last_word: limits.last_word,
        hyphenate_ladder_limit: limits.ladder_limit as u32,
        language: hyphenator.map(|h| format!("{:?}", h.language())),
        word_spacing: [
            resolved.minimum_word_spacing.unwrap_or(80.0),
            desired_ws,
            resolved.maximum_word_spacing.unwrap_or(133.0),
        ],
        letter_spacing: [
            resolved.minimum_letter_spacing.unwrap_or(0.0),
            desired_ls,
            resolved.maximum_letter_spacing.unwrap_or(0.0),
        ],
        glyph_scaling: [
            resolved.minimum_glyph_scaling.unwrap_or(desired_gs),
            desired_gs,
            resolved.maximum_glyph_scaling.unwrap_or(desired_gs),
        ],
        grid_alignment: resolved
            .grid_alignment
            .as_ref()
            .map(enum_name)
            .unwrap_or_else(|| "None".into()),
    }
}

/// The word around paragraph-local byte `at` (`[start, end)` bytes): the
/// letters, digits and hyphens on either side, discretionary hyphens
/// included.
fn word_around(text: &str, at: usize) -> (usize, usize) {
    let part = |c: char| !is_space(c) && !c.is_whitespace();
    let mut start = at.min(text.len());
    while start > 0 {
        let Some(c) = text[..start].chars().next_back() else {
            break;
        };
        if !part(c) {
            break;
        }
        start -= c.len_utf8();
    }
    let mut end = at.min(text.len());
    while end < text.len() {
        let Some(c) = text[end..].chars().next() else {
            break;
        };
        if !part(c) {
            break;
        }
        end += c.len_utf8();
    }
    (start, end)
}

/// The hyphenation points the dictionary offers in the word at `at` of
/// paragraph `pi`, as the composer would have weighed them.
fn hyphenation_at(
    doc: &Document,
    para: &Paragraph,
    text: &StoryText,
    pi: u32,
    at: usize,
    used: Option<u32>,
) -> Option<HyphenationEvidence> {
    let ptext = text.paragraphs.get(pi as usize)?;
    let (ws, we) = word_around(ptext, at);
    if ws >= we {
        return None;
    }
    let word = &ptext[ws..we];
    let resolved = doc.resolved_paragraph_attrs(para);
    let runs: Vec<paged_scene::ResolvedRunAttrs> = para
        .runs
        .iter()
        .map(|r| doc.resolved_run_attrs(para, r))
        .collect();
    let limits = paged_renderer::hyphenation_limits(&resolved);
    let on = resolved.hyphenation.unwrap_or(true);
    let is_last_word = ptext[we..].chars().all(|c| c.is_whitespace());
    let soft = word.contains(paged_text::SOFT_HYPHEN);
    let language = paged_renderer::hyphenation_language(&resolved, &runs);
    let hyphenators = paged_text::Hyphenators::new();
    let hyphenator = hyphenators.resolve(language);
    let points: Vec<usize> = if soft {
        paged_text::soft_hyphen_opportunities(word, &limits, is_last_word)
    } else if !on {
        Vec::new()
    } else {
        hyphenator
            .map(|h| h.opportunities_for(word, &limits, is_last_word))
            .unwrap_or_default()
    };
    let letters = word.chars().filter(|c| c.is_alphabetic()).count();
    let reason = points.is_empty().then(|| {
        if !on && !soft {
            "off"
        } else if hyphenator.is_none() && !soft {
            "noLanguage"
        } else if is_last_word && !limits.last_word {
            "lastWord"
        } else if letters <= limits.words_longer_than {
            "short"
        } else if !limits.capitalized_words
            && word
                .chars()
                .find(|c| c.is_alphabetic())
                .is_some_and(char::is_uppercase)
        {
            "capitalized"
        } else {
            "noPattern"
        }
        .to_string()
    });
    let base = text.char_at(pi, ws as u32);
    Some(HyphenationEvidence {
        word: word.replace(paged_text::SOFT_HYPHEN, ""),
        word_start: base,
        points: points
            .iter()
            .map(|p| base + word[..*p].chars().count() as u32)
            .collect(),
        used,
        hyphenation_on: on,
        reason,
    })
}

/// What a line's glyph positions say about its spacing.
struct Spacing {
    /// Each word space as set, in % of the font's space: the room between
    /// the letters on either side of it over the space glyph's advance.
    spaces: Vec<f32>,
    /// The space added between letters, summed and per gap, pt.
    letter_extra: f32,
    letter_gaps: usize,
    /// The mean advance of the line's letters, pt.
    letter_advance: f32,
}

/// The spacing a line was set with, from its glyph positions. Where the
/// composer puts a space's stretch (before the space glyph or in its
/// advance) does not matter: a word space is measured from the end of the
/// letter before it to the start of the letter after it.
fn spacing(line: &LineLayout, text: &StoryText) -> Spacing {
    let c = &line.clusters;
    let kind = |i: usize| text.char_of(line.paragraph_idx, c[i].byte);
    let mut spaces = Vec::new();
    let mut letter_extra = 0.0f32;
    let mut letter_gaps = 0usize;
    let mut advances = 0.0f32;
    let mut letters = 0usize;
    let mut i = 0;
    while i < c.len() {
        let Some(ch) = kind(i) else {
            i += 1;
            continue;
        };
        if is_space(ch) {
            // A run of spaces between two letters.
            let mut j = i;
            let mut natural = 0.0f32;
            while j < c.len() && kind(j).is_some_and(is_space) {
                natural += c[j].advance_pt;
                j += 1;
            }
            if i > 0 && j < c.len() && natural > 0.01 {
                let from = c[i - 1].x_pt + c[i - 1].advance_pt;
                spaces.push((c[j].x_pt - from) / natural * 100.0);
            }
            i = j;
            continue;
        }
        if !ch.is_whitespace() {
            advances += c[i].advance_pt;
            letters += 1;
            if i + 1 < c.len() && kind(i + 1).is_some_and(|n| !is_space(n) && !n.is_whitespace()) {
                letter_extra += c[i + 1].x_pt - (c[i].x_pt + c[i].advance_pt);
                letter_gaps += 1;
            }
        }
        i += 1;
    }
    Spacing {
        spaces,
        letter_extra,
        letter_gaps,
        letter_advance: if letters == 0 {
            0.0
        } else {
            advances / letters as f32
        },
    }
}

/// The evidence for `query` from `built`, the build of `doc`.
fn evidence(doc: &Document, built: &BuiltDocument, query: &LineEvidenceQuery) -> Vec<LineEvidence> {
    let Some(parsed) = doc.stories.iter().find(|s| s.self_id == query.story) else {
        return Vec::new();
    };
    let paragraphs = &parsed.story.paragraphs;
    let text = StoryText::of(paragraphs);
    let settings: Vec<ParagraphComposition> = paragraphs
        .iter()
        .enumerate()
        .map(|(i, p)| paragraph_composition(doc, i as u32, p))
        .collect();
    let overset = built.diagnostics.overset_story_ids().contains(&query.story);
    let lines: Vec<&LineLayout> = built
        .story_layout(&query.story)
        .into_iter()
        .filter(|l| l.cell.is_none())
        .collect();
    let mut out = Vec::with_capacity(lines.len());
    for (k, line) in lines.iter().enumerate() {
        let next = lines.get(k + 1);
        let pi = line.paragraph_idx;
        let start = text.char_at(pi, line.byte_range.start);
        let end = text.char_at(pi, line.byte_range.end);
        if let Some((from, to)) = query.range {
            if end < from || start > to.max(from) {
                continue;
            }
        }
        if let Some(frame) = &query.frame {
            if line.frame_id.as_deref() != Some(frame.as_str()) {
                continue;
            }
        }
        let comp = &line.composition;
        let para_settings = settings.get(pi as usize);
        let last_of_paragraph = next.is_none_or(|n| n.paragraph_idx != pi);
        let last_line = next.is_none();
        let before = text.char_before(pi, line.byte_range.end);
        let at_end = text.char_of(pi, line.byte_range.end);
        let break_kind = if comp.hyphenated {
            if before == Some(paged_text::SOFT_HYPHEN) {
                BreakKind::DiscretionaryHyphen
            } else {
                BreakKind::Hyphen
            }
        } else if before == Some('\u{2028}') || at_end == Some('\u{2028}') {
            BreakKind::ForcedLineBreak
        } else if last_of_paragraph {
            if last_line && !overset && (pi as usize + 1) >= paragraphs.len() {
                BreakKind::StoryEnd
            } else if last_line && overset {
                // The line the frames end on: the text goes on unplaced.
                match at_end {
                    Some(c) if is_space(c) || c.is_whitespace() => BreakKind::WordSpace,
                    None => BreakKind::ParagraphEnd,
                    Some(_) => BreakKind::Emergency,
                }
            } else {
                BreakKind::ParagraphEnd
            }
        } else if matches!(before, Some('-') | Some('\u{2010}')) {
            BreakKind::HardHyphen
        } else {
            match at_end {
                Some(c) if is_space(c) || c.is_whitespace() => BreakKind::WordSpace,
                _ => BreakKind::Emergency,
            }
        };
        let hyphenation = match break_kind {
            BreakKind::Hyphen | BreakKind::DiscretionaryHyphen => {
                let used = text.char_at(pi, line.byte_range.end);
                hyphenation_at(
                    doc,
                    &paragraphs[pi as usize],
                    &text,
                    pi,
                    line.byte_range.end as usize,
                    Some(used),
                )
            }
            BreakKind::WordSpace => {
                // The word that went to the next line whole.
                let ptext = &text.paragraphs[pi as usize];
                let mut at = line.byte_range.end as usize;
                while at < ptext.len() {
                    let Some(c) = ptext[at..].chars().next() else {
                        break;
                    };
                    if !(is_space(c) || c.is_whitespace()) {
                        break;
                    }
                    at += c.len_utf8();
                }
                (at < ptext.len())
                    .then(|| hyphenation_at(doc, &paragraphs[pi as usize], &text, pi, at, None))
                    .flatten()
            }
            _ => None,
        };
        let left = line.clusters.first().map(|c| c.x_pt).unwrap_or_default();
        let right = line
            .clusters
            .iter()
            .map(|c| c.x_pt + c.advance_pt)
            .fold(left, f32::max);
        let sp = spacing(line, &text);
        let spaces = sp.spaces.clone();
        let letter_spacing = if sp.letter_gaps == 0 {
            0.0
        } else {
            sp.letter_extra / sp.letter_gaps as f32
        };
        let ws_mean =
            (!spaces.is_empty()).then(|| spaces.iter().sum::<f32>() / spaces.len() as f32);
        let ws_min = spaces.iter().copied().reduce(f32::min);
        let ws_max = spaces.iter().copied().reduce(f32::max);
        let band = para_settings
            .map(|s| s.word_spacing)
            .unwrap_or([80.0, 100.0, 133.0]);
        let mut outliers = Vec::new();
        let tol = 0.5;
        let stretched = comp.justified && !last_of_paragraph;
        if let (true, Some(max)) = (stretched, ws_max) {
            if max > band[2] + tol {
                outliers.push("wordSpacingAboveMaximum".to_string());
            }
        }
        if let Some(min) = ws_min {
            if min < band[0] - tol {
                outliers.push("wordSpacingBelowMinimum".to_string());
            }
        }
        if letter_spacing.abs() > 0.05 && stretched {
            outliers.push("letterSpacing".to_string());
        }
        if comp.available_pt > 0.0 && comp.natural_pt > comp.available_pt + 0.5 && comp.ratio <= 0.0
        {
            // Wider than the measure even at its tightest.
            if ws_min.is_none_or(|m| m <= band[0] + tol) {
                outliers.push("overfull".to_string());
            }
        }
        let tightness =
            match ws_mean.filter(|_| stretched || ws_min.is_some_and(|m| m < band[1] - tol)) {
                Some(ws) if ws > band[2] + tol => Tightness::VeryLoose,
                Some(ws) if ws < band[0] - tol => Tightness::VeryTight,
                Some(ws) if ws > band[1] + (band[2] - band[1]) / 2.0 => Tightness::Loose,
                Some(ws) if ws < band[1] - (band[1] - band[0]) / 2.0 => Tightness::Tight,
                _ if outliers.iter().any(|o| o == "overfull") => Tightness::VeryTight,
                // A line without spaces stretched by its letters (a single
                // word set to the measure) is loose by how far they moved.
                None if stretched && letter_spacing > 0.05 => {
                    if sp.letter_advance > 0.0 && letter_spacing / sp.letter_advance > 0.1 {
                        Tightness::VeryLoose
                    } else {
                        Tightness::Loose
                    }
                }
                _ => Tightness::Normal,
            };
        let line_text: String = {
            let p = &text.paragraphs[pi as usize];
            let a = (line.byte_range.start as usize).min(p.len());
            let b = (line.byte_range.end as usize).min(p.len()).max(a);
            p.get(a..b)
                .unwrap_or_default()
                .replace(paged_text::SOFT_HYPHEN, "")
        };
        out.push(LineEvidence {
            page_id: line.page_id.clone(),
            frame_id: line.frame_id.clone(),
            paragraph: pi,
            line: line.line_idx,
            start,
            end,
            caret_start: crate::mutate::char_to_content_offset(paragraphs, start),
            caret_end: crate::mutate::char_to_content_offset(paragraphs, end),
            text: line_text,
            baseline: line.baseline_y_pt,
            left,
            right,
            top: line.baseline_y_pt - line.ascent_pt,
            bottom: line.baseline_y_pt + line.descent_pt,
            available: comp.available_pt,
            natural: comp.natural_pt,
            ratio: comp.ratio,
            word_spacing: ws_mean,
            word_spacing_min: ws_min,
            word_spacing_max: ws_max,
            letter_spacing,
            break_kind,
            frame_end: next.is_some_and(|n| n.frame_id != line.frame_id),
            overset_after: last_line && overset,
            hyphenation,
            tightness,
            outliers,
            composer: composer_name(comp.composer).into(),
            justified: comp.justified,
            grid_shift: comp.grid_shift_pt,
        });
    }
    out
}

/// The report for `query` from `doc` and its build.
fn report(
    doc: &Document,
    built: &BuiltDocument,
    query: &LineEvidenceQuery,
    revision: u64,
) -> LineEvidenceReport {
    let Some(parsed) = doc.stories.iter().find(|s| s.self_id == query.story) else {
        return LineEvidenceReport {
            story_id: query.story.clone(),
            found: false,
            preview: false,
            refused: None,
            lines: Vec::new(),
            paragraphs: Vec::new(),
            overset: None,
            revision,
        };
    };
    let lines = evidence(doc, built, query);
    let wanted: std::collections::BTreeSet<u32> = lines.iter().map(|l| l.paragraph).collect();
    let paragraphs = parsed
        .story
        .paragraphs
        .iter()
        .enumerate()
        .filter(|(i, _)| wanted.contains(&(*i as u32)))
        .map(|(i, p)| paragraph_composition(doc, i as u32, p))
        .collect();
    let overset = built
        .diagnostics
        .overset_story_ids()
        .contains(&query.story)
        .then(|| {
            let text = StoryText::of(&parsed.story.paragraphs);
            let placed = built
                .story_layout(&query.story)
                .iter()
                .filter(|l| l.cell.is_none())
                .map(|l| text.char_at(l.paragraph_idx, l.byte_range.end))
                .max()
                .unwrap_or(0);
            let chars: Vec<char> = text.paragraphs.iter().flat_map(|p| p.chars()).collect();
            let mut from = placed;
            while (from as usize) < chars.len() && chars[from as usize].is_whitespace() {
                from += 1;
            }
            OversetEvidence {
                from,
                characters: text.total.saturating_sub(from),
            }
        });
    LineEvidenceReport {
        story_id: query.story.clone(),
        found: true,
        preview: false,
        refused: None,
        lines,
        paragraphs,
        overset,
        revision,
    }
}

impl CanvasModel {
    /// The Typography Debugger's evidence for `query` (engine ADR 1308).
    /// With `preview`, the evidence of a copy of the document with that
    /// write applied; the document is never changed.
    pub fn line_evidence(&self, query: &LineEvidenceQuery) -> LineEvidenceReport {
        let revision = self.document_revision();
        let Some(preview) = &query.preview else {
            return report(&self.scene, &self.built, query, revision);
        };
        match self.preview_build(preview) {
            Ok((scene, built)) => {
                let mut out = report(&scene, &built, query, revision);
                out.preview = true;
                out
            }
            Err(why) => {
                let mut out = report(&self.scene, &self.built, query, revision);
                out.refused = Some(why);
                out
            }
        }
    }

    /// `mutation` applied to a copy of the document, and the copy built.
    /// Only writes the operation layer applies on its own are previewed:
    /// properties of items, text ranges, paragraphs and styles, and
    /// batches of them.
    fn preview_build(&self, mutation: &Mutation) -> Result<(Document, BuiltDocument), String> {
        let mut scene = self.scene.clone();
        let mut ops = Vec::new();
        let mut mint = 0u64;
        let flat: Vec<&Mutation> = match mutation {
            Mutation::Batch { ops } => ops.iter().collect(),
            other => vec![other],
        };
        for m in flat {
            match m {
                Mutation::SetElementProperty { .. }
                | Mutation::SetStyleProperty { .. }
                | Mutation::ApplyStyle { .. } => {}
                _ => return Err("unsupported".into()),
            }
            let op = self
                .preview_operation(m, &mut mint)
                .ok_or_else(|| "unsupported".to_string())?;
            ops.push(op);
        }
        for op in &ops {
            paged_mutate::apply_checked(&mut scene, op, self.session_policy())
                .map_err(|e| e.to_string())?;
        }
        let built = self.cold_build_of(&scene).map_err(|e| format!("{e:?}"))?;
        Ok((scene, built))
    }
}
