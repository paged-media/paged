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

//! Note reference markers in save-back (doc ADR 611).
//!
//! A body run holding a Word note reference reads, on the canvas and in the
//! lowering, as the engine's marker character (`\u{E01C}` for a footnote,
//! `\u{E01D}` for an endnote). The differ and the patcher work on Word's
//! text, where the reference is an element, not a character: both sides are
//! read without the markers (a run that held only a reference is dropped,
//! as the lowering dropped it before notes were placed, so the runs line
//! up with the bindings), and the patcher keeps the reference element where
//! it stands in its run.

use docx_core::Run;
use docx_lower::ir::{LoweredBlock, LoweredDoc, LoweredParagraph};

use crate::overlay::StoryContentIn;

/// Whether `c` is a note reference marker.
pub fn is_marker(c: char) -> bool {
    c == Run::FOOTNOTE_MARKER || c == Run::ENDNOTE_MARKER
}

fn strip(text: &mut String) {
    if text.chars().any(is_marker) {
        text.retain(|c| !is_marker(c));
    }
}

fn strip_paragraph(p: &mut LoweredParagraph) {
    let before: Vec<usize> = p.runs.iter().map(|r| r.text.chars().count()).collect();
    for r in p.runs.iter_mut() {
        strip(&mut r.text);
    }
    // Pictures and break segments are addressed by char offset: move the
    // ones after a marker back by it.
    let removed: Vec<(usize, usize)> = {
        let mut out = Vec::new();
        let mut at = 0usize;
        for (r, n) in p.runs.iter().zip(&before) {
            let kept = r.text.chars().count();
            if kept < *n {
                out.push((at, *n - kept));
            }
            at += n;
        }
        out
    };
    p.runs.retain(|r| !r.text.is_empty());
    if removed.is_empty() {
        return;
    }
    let shift = |offset: u32| -> u32 {
        let gone: usize = removed
            .iter()
            .filter(|(start, _)| (*start as u32) < offset)
            .map(|(_, n)| *n)
            .sum();
        offset.saturating_sub(gone as u32)
    };
    for img in p.images.iter_mut() {
        img.at = shift(img.at);
    }
    for seg in p.segments.iter_mut() {
        seg.at = shift(seg.at);
    }
}

/// `ir` without note markers in its body runs.
pub fn strip_lowered(mut ir: LoweredDoc) -> LoweredDoc {
    for block in ir.story.blocks.iter_mut() {
        if let LoweredBlock::Paragraph(p) = block {
            strip_paragraph(p);
        }
    }
    ir
}

/// A read-back story without note markers in its runs.
pub fn strip_content(content: &StoryContentIn) -> StoryContentIn {
    let mut out = content.clone();
    for p in out.paragraphs.iter_mut() {
        for r in p.runs.iter_mut() {
            strip(&mut r.text);
        }
    }
    out
}
