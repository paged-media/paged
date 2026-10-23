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

//! The DOC-03 read → edited-`LoweredDoc` mapper. The host's structured read
//! (`host.document.storyContent`, core wire `StoryContent`) hands back the EDITED
//! story as paragraphs → runs → text + applied styles. Because paged.doc created
//! every style via `applyStyle`, a run's `characterStyle` IS the plugin's own
//! `char_style_id` token — so the read overlays cleanly onto the import baseline,
//! yielding the "edited" lowering that `diff` compares against the baseline.
//!
//! Isolation-clean: this mirrors the core wire shape as a plugin-local type
//! (deserialized from the JSON the bundle forwards) — no core dependency.

use docx_lower::ir::{LoweredBlock, LoweredDoc, LoweredParagraph, LoweredRun};

use crate::diff::Align;
use serde::{Deserialize, Serialize};

/// Plugin-local twin of the core `StoryContent` wire struct (camelCase JSON).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoryContentIn {
    pub self_id: String,
    pub paragraphs: Vec<ParagraphContentIn>,
}

/// One read-back paragraph.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParagraphContentIn {
    #[serde(default)]
    pub paragraph_style: Option<String>,
    pub runs: Vec<RunContentIn>,
}

/// One read-back run. Only `text` + `character_style` drive the overlay today
/// (direct-override fields are carried for forward use but not yet applied).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunContentIn {
    pub text: String,
    #[serde(default)]
    pub character_style: Option<String>,
}

/// The read-back paragraphs one baseline paragraph poured as, folded back into
/// ONE (ADR 028/029): a page/column break inside a Word paragraph pours as
/// `1 + segments` native paragraphs. Where a break fell inside a baseline run,
/// that run came back as two (the end of one part, the start of the next) and
/// is joined again; empty runs of an empty part are dropped.
fn fold_segments(
    baseline: &docx_lower::ir::LoweredParagraph,
    parts: &[ParagraphContentIn],
) -> ParagraphContentIn {
    let mut runs: Vec<RunContentIn> = parts.first().map(|p| p.runs.clone()).unwrap_or_default();
    // Run boundaries in the baseline's contiguous char space.
    let mut bounds = vec![0u32];
    for r in &baseline.runs {
        bounds.push(bounds.last().copied().unwrap_or(0) + r.text.chars().count() as u32);
    }
    for (k, part) in parts.iter().enumerate().skip(1) {
        let at = baseline.segments.get(k - 1).map_or(0, |s| s.at);
        let splits_a_run = !bounds.contains(&at);
        let mut next = part.runs.iter().filter(|r| !r.text.is_empty()).cloned();
        if splits_a_run {
            if let (Some(last), Some(first)) = (runs.last_mut(), next.next()) {
                last.text.push_str(&first.text);
            }
        }
        runs.extend(next);
    }
    ParagraphContentIn {
        paragraph_style: parts.first().and_then(|p| p.paragraph_style.clone()),
        runs,
    }
}

/// Overlay the read-back story onto the import `baseline`, producing the EDITED
/// lowering. Structure-preserving: read-back paragraphs map 1:1 onto the
/// baseline's PARAGRAPH blocks in order (table blocks are skipped: the read-back
/// story holds no native table, its cells come through [`overlay_cells`]); a
/// paragraph whose run list changed in style is replaced (the diff aligns it).
pub fn overlay_story_content(baseline: &LoweredDoc, content: &StoryContentIn) -> LoweredDoc {
    let mut edited = baseline.clone();
    let mut ci = 0usize;
    for block in edited.story.blocks.iter_mut() {
        let p = match block {
            LoweredBlock::Paragraph(p) => p,
            LoweredBlock::Table(t) => {
                // A native table is not in the read-back paragraphs. One
                // that FLOWED as text is: skip its paragraphs (the Word
                // table is left as it was).
                ci += t.flow.iter().map(|p| 1 + p.segments.len()).sum::<usize>();
                continue;
            }
        };
        let parts = 1 + p.segments.len();
        if ci >= content.paragraphs.len() {
            break; // read-back ran out of paragraphs
        }
        let end = (ci + parts).min(content.paragraphs.len());
        let folded = fold_segments(p, &content.paragraphs[ci..end]);
        let cp = &folded;
        ci = end;
        if cp.runs.len() == p.runs.len() {
            for (run, cr) in p.runs.iter_mut().zip(&cp.runs) {
                run.text = cr.text.clone();
                run.char_style_id = cr.character_style.clone();
            }
        } else if same_style_spans(
            p.runs.iter().map(|r| r.char_style_id.as_deref()),
            cp.runs.iter().map(|r| r.character_style.as_deref()),
        ) {
            // The engine joins neighbouring runs of one style (a merge
            // field's result after plain text reads back as one run): the
            // styles still match span for span, so only text changed. Keep
            // the Word runs and patch the text into them, as a cell's is.
            let text: String = cp.runs.iter().map(|r| r.text.as_str()).collect();
            if patch_runs(&mut p.runs, &text).is_err() {
                continue;
            }
        } else {
            // Increment 2 — the run list CHANGED (a run was added or removed in
            // the editor). Replace it wholesale; `diff` aligns the two lists by
            // (text, style) identity and emits the insert/delete ops.
            let template = p.runs.first().cloned().unwrap_or_default();
            p.runs = cp
                .runs
                .iter()
                .map(|cr| LoweredRun {
                    text: cr.text.clone(),
                    char_style_id: cr.character_style.clone(),
                    ..template.clone()
                })
                .collect();
        }
    }
    edited
}

/// One native table cell as the host reads it back: the table's `block` in
/// the lowered story, the `cell`'s index in its lowered cell list, and its
/// live text — its paragraphs joined by `\n`, as the engine reads a cell's
/// `text` (the read-back story holds no table, so cells come separately).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellContentIn {
    pub block: usize,
    pub cell: usize,
    pub text: String,
}

/// Overlay read-back table cells onto the `edited` lowering (the cell
/// patcher): each cell paragraph whose text changed keeps its run list, and
/// the changed span — what lies between the text the old and the new share
/// at the start and at the end — goes into the run it starts in; the runs it
/// covered further on lose their covered text. Run count and run properties
/// stay, so `diff` reports run text edits that patch the cell's `<w:t>`s in
/// place. A paragraph with no run that gains text gets one run.
///
/// A cell whose paragraph count changed on the canvas (paragraphs added or
/// removed) is aligned paragraph by paragraph by text
/// (`align_cell_paragraphs`, the alignment `diff` makes again): a kept
/// paragraph is patched as above, an added one is a copy of its neighbour —
/// the paragraph before it, or the one after it at the cell's start — with
/// one run carrying its text, and a removed one is dropped (never the cell's
/// last: Word requires it). `diff` turns these into cell paragraph clones
/// and deletes. A table poured as text, or a cell that is not in the
/// lowering, is left as it was and reported in the returned ledger.
pub fn overlay_cells(edited: &mut LoweredDoc, cells: &[CellContentIn]) -> Vec<String> {
    let mut skips = Vec::new();
    for c in cells {
        let Some(LoweredBlock::Table(t)) = edited.story.blocks.get_mut(c.block) else {
            skips.push(format!(
                "block {}: no table to write the cell into",
                c.block
            ));
            continue;
        };
        if !t.flow.is_empty() {
            skips.push(format!(
                "block {}: a table poured as text keeps its Word cells",
                c.block
            ));
            continue;
        }
        let Some(cell) = t.cells.get_mut(c.cell) else {
            skips.push(format!("block {}: no cell {}", c.block, c.cell));
            continue;
        };
        let texts: Vec<String> = c.text.split('\n').map(str::to_string).collect();
        if texts.len() != cell.paragraphs.len() {
            cell.paragraphs = restructure_cell(&cell.paragraphs, &texts);
            continue;
        }
        for (k, (p, new)) in cell.paragraphs.iter_mut().zip(&texts).enumerate() {
            if let Err(why) = patch_paragraph(p, new) {
                skips.push(format!(
                    "block {} cell {} paragraph {k}: {why}",
                    c.block, c.cell
                ));
            }
        }
    }
    skips
}

/// Patch `new` into one cell paragraph's runs ([`patch_runs`]); a paragraph
/// with no run that gains text gets one (`diff` adds it as a run).
fn patch_paragraph(p: &mut LoweredParagraph, new: &str) -> Result<(), String> {
    if p.runs.is_empty() && !new.is_empty() {
        p.runs.push(LoweredRun {
            text: new.to_string(),
            ..Default::default()
        });
        return Ok(());
    }
    patch_runs(&mut p.runs, new)
}

/// A cell's paragraphs once the read-back `texts` (a different count) are
/// aligned onto them — see [`overlay_cells`].
fn restructure_cell(paras: &[LoweredParagraph], texts: &[String]) -> Vec<LoweredParagraph> {
    let old: Vec<String> = paras
        .iter()
        .map(|p| p.runs.iter().map(|r| r.text.as_str()).collect())
        .collect();
    let steps = crate::diff::align_cell_paragraphs(&old, texts);
    let first_match = steps.iter().find_map(|s| match s {
        Align::Match(b, _) => Some(*b),
        _ => None,
    });
    let mut out: Vec<LoweredParagraph> = Vec::with_capacity(texts.len());
    let mut anchor: Option<usize> = None;
    for step in steps {
        match step {
            Align::Match(b, e) => {
                anchor = Some(b);
                let mut p = paras[b].clone();
                // A run-less paragraph gains its run; `patch_runs` cannot fail
                // otherwise.
                let _ = patch_paragraph(&mut p, &texts[e]);
                out.push(p);
            }
            Align::Del(_) => {}
            Align::Ins(e) => {
                let (from, last) = match (anchor, first_match) {
                    (Some(a), _) => (&paras[a], true),
                    (None, Some(f)) => (&paras[f], false),
                    (None, None) => continue,
                };
                let run = if last {
                    from.runs.last()
                } else {
                    from.runs.first()
                };
                out.push(LoweredParagraph {
                    para_style_id: from.para_style_id.clone(),
                    list: from.list,
                    source_index: from.source_index,
                    runs: vec![LoweredRun {
                        text: texts[e].clone(),
                        char_style_id: run.and_then(|r| r.char_style_id.clone()),
                        ..Default::default()
                    }],
                    ..Default::default()
                });
            }
        }
    }
    out
}

/// Two run lists carry the same styles in the same order once neighbouring
/// runs of one style are taken as one span.
fn same_style_spans<'a>(
    a: impl Iterator<Item = Option<&'a str>>,
    b: impl Iterator<Item = Option<&'a str>>,
) -> bool {
    let spans = |it: &mut dyn Iterator<Item = Option<&'a str>>| {
        let mut out: Vec<Option<&'a str>> = Vec::new();
        for s in it {
            if out.last() != Some(&s) {
                out.push(s);
            }
        }
        out
    };
    let (mut a, mut b) = (a, b);
    spans(&mut a) == spans(&mut b)
}

/// Rewrite `runs` so their texts concatenate to `new`, keeping the run list:
/// the span that differs from the old concatenation goes to the run it
/// starts in. Errors when there is no run to hold new text.
fn patch_runs(runs: &mut [LoweredRun], new: &str) -> Result<(), String> {
    let old: Vec<char> = runs.iter().flat_map(|r| r.text.chars()).collect();
    let next: Vec<char> = new.chars().collect();
    if old == next {
        return Ok(());
    }
    if runs.is_empty() {
        return Err("the Word paragraph has no run to hold the text".into());
    }
    let prefix = old.iter().zip(&next).take_while(|(a, b)| a == b).count();
    let max_suffix = old.len().min(next.len()) - prefix;
    let suffix = old
        .iter()
        .rev()
        .zip(next.iter().rev())
        .take(max_suffix)
        .take_while(|(a, b)| a == b)
        .count();
    let (cut_from, cut_to) = (prefix, old.len() - suffix);
    let insert: String = next[prefix..next.len() - suffix].iter().collect();
    // The run the change starts in: the one holding `cut_from`, or for an
    // insertion at a run boundary the run before it (it extends that run's
    // text, as typing at the end of a word does); at 0 the first run.
    let mut start = 0usize;
    let mut target = runs.len() - 1;
    for (i, r) in runs.iter().enumerate() {
        let len = r.text.chars().count();
        let end = start + len;
        if cut_from < end || (cut_from == end && cut_from == cut_to && len > 0) {
            target = i;
            break;
        }
        start = end;
    }
    let mut at = 0usize;
    for (i, r) in runs.iter_mut().enumerate() {
        let chars: Vec<char> = r.text.chars().collect();
        let (s, e) = (at, at + chars.len());
        at = e;
        // The run's own chars outside the cut span stay.
        let keep_head: String = chars[..cut_from.clamp(s, e) - s].iter().collect();
        let keep_tail: String = chars[cut_to.clamp(s, e) - s..].iter().collect();
        r.text = if i == target {
            format!("{keep_head}{insert}{keep_tail}")
        } else {
            format!("{keep_head}{keep_tail}")
        };
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn runs(texts: &[&str]) -> Vec<LoweredRun> {
        texts
            .iter()
            .map(|t| LoweredRun {
                text: (*t).to_string(),
                ..Default::default()
            })
            .collect()
    }

    fn texts(rs: &[LoweredRun]) -> Vec<&str> {
        rs.iter().map(|r| r.text.as_str()).collect()
    }

    #[test]
    fn a_change_inside_one_run_stays_in_it() {
        let mut rs = runs(&["Price ", "12.00", " EUR"]);
        patch_runs(&mut rs, "Price 14.50 EUR").unwrap();
        assert_eq!(texts(&rs), ["Price ", "14.50", " EUR"]);
    }

    #[test]
    fn typing_at_a_run_end_extends_that_run() {
        let mut rs = runs(&["Apple", " pie"]);
        patch_runs(&mut rs, "Apples pie").unwrap();
        assert_eq!(texts(&rs), ["Apples", " pie"]);
        let mut rs = runs(&["Apple"]);
        patch_runs(&mut rs, "Apple tart").unwrap();
        assert_eq!(texts(&rs), ["Apple tart"]);
    }

    #[test]
    fn a_change_across_runs_lands_in_the_first() {
        let mut rs = runs(&["one ", "two ", "three"]);
        patch_runs(&mut rs, "one 2 three").unwrap();
        assert_eq!(texts(&rs), ["one ", "2 ", "three"]);
        let mut rs = runs(&["ab", "cd"]);
        patch_runs(&mut rs, "aXd").unwrap();
        assert_eq!(texts(&rs), ["aX", "d"]);
        let mut rs = runs(&["ab", "cd"]);
        patch_runs(&mut rs, "").unwrap();
        assert_eq!(texts(&rs), ["", ""]);
    }

    #[test]
    fn an_empty_run_list_cannot_take_text() {
        let mut rs = runs(&[]);
        assert!(patch_runs(&mut rs, "x").is_err());
        assert!(patch_runs(&mut rs, "").is_ok());
    }

    #[test]
    fn runs_the_engine_joined_are_patched_in_place() {
        use docx_lower::ir::LoweredParagraph;
        let mut base = LoweredDoc::default();
        base.story
            .blocks
            .push(LoweredBlock::Paragraph(LoweredParagraph {
                runs: runs(&["Dear ", "«Name»"]),
                ..Default::default()
            }));
        let read = |text: &str| StoryContentIn {
            self_id: "s".into(),
            paragraphs: vec![ParagraphContentIn {
                paragraph_style: None,
                runs: vec![RunContentIn {
                    text: text.into(),
                    character_style: None,
                }],
            }],
        };
        let texts_of = |d: &LoweredDoc| match &d.story.blocks[0] {
            LoweredBlock::Paragraph(p) => p.runs.iter().map(|r| r.text.clone()).collect::<Vec<_>>(),
            LoweredBlock::Table(_) => unreachable!(),
        };
        let same = overlay_story_content(&base, &read("Dear «Name»"));
        assert_eq!(texts_of(&same), ["Dear ", "«Name»"]);
        let edited = overlay_story_content(&base, &read("Dear «Name»!"));
        assert_eq!(texts_of(&edited), ["Dear ", "«Name»!"]);
    }

    #[test]
    fn multibyte_text_is_cut_on_chars() {
        let mut rs = runs(&["Grüße ", "€5"]);
        patch_runs(&mut rs, "Grüße €7").unwrap();
        assert_eq!(texts(&rs), ["Grüße ", "€7"]);
    }
}
