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

//! SVG text as text frames: when a text can stay text, and where its
//! lines sit.

use super::geom::Affine;
use super::ImportFont;

/// One run of a line: a character range with its attributes.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct Run {
    /// Character offsets into the line's text, `[start, end)`.
    pub start: u32,
    pub end: u32,
    pub family: String,
    pub style: String,
    pub size: f32,
    pub fill: Option<usvg::Color>,
    /// Tracking in thousandths of an em.
    pub tracking: f32,
    pub underline: bool,
    pub strike: bool,
}

/// One text chunk as a text frame (page-local bounds).
#[derive(Debug, Clone, PartialEq)]
pub(super) struct Line {
    pub text: String,
    pub top: f32,
    pub left: f32,
    pub bottom: f32,
    pub right: f32,
    pub justification: Option<&'static str>,
    pub runs: Vec<Run>,
}

/// The number of `<text>` elements the source draws (outside the
/// definitions only something else refers to). Zero for a compressed
/// file or one roxmltree cannot read.
pub(super) fn count_text_elements(svg: &[u8]) -> u32 {
    let Ok(s) = std::str::from_utf8(svg) else {
        return 0;
    };
    let Ok(doc) = usvg::roxmltree::Document::parse(s) else {
        return 0;
    };
    let hidden = ["defs", "symbol", "clipPath", "mask", "pattern", "marker"];
    doc.descendants()
        .filter(|n| n.is_element() && n.tag_name().name() == "text")
        .filter(|n| {
            !n.ancestors()
                .skip(1)
                .any(|a| a.is_element() && hidden.contains(&a.tag_name().name()))
        })
        .count() as u32
}

/// The family `f` resolves to among `fonts`: a named family the caller
/// has (case-insensitive), or — for a generic family — the face usvg
/// lays generic text out with, the first.
fn resolve_family(families: &[usvg::FontFamily], fonts: &[ImportFont<'_>]) -> Option<String> {
    for f in families {
        match f {
            usvg::FontFamily::Named(name) => {
                if let Some(font) = fonts.iter().find(|x| x.family.eq_ignore_ascii_case(name)) {
                    return Some(font.family.to_string());
                }
            }
            _ => return fonts.first().map(|f| f.family.to_string()),
        }
    }
    None
}

fn style_name(font: &usvg::Font) -> String {
    let bold = font.weight() >= 600;
    let italic = !matches!(font.style(), usvg::FontStyle::Normal);
    match (bold, italic) {
        (true, true) => "Bold Italic",
        (true, false) => "Bold",
        (false, true) => "Italic",
        (false, false) => "Regular",
    }
    .to_string()
}

/// The typographic ascender of a font over its em (OS/2 `sTypoAscender`,
/// else `hhea` ascender), the first baseline of an InDesign text frame
/// (engine ADR 201). `None` when the tables cannot be read.
pub(super) fn ascent_em(bytes: &[u8]) -> Option<f32> {
    let u16_at = |o: usize| -> Option<u16> {
        Some(u16::from_be_bytes([*bytes.get(o)?, *bytes.get(o + 1)?]))
    };
    let u32_at = |o: usize| -> Option<u32> {
        Some(u32::from_be_bytes([
            *bytes.get(o)?,
            *bytes.get(o + 1)?,
            *bytes.get(o + 2)?,
            *bytes.get(o + 3)?,
        ]))
    };
    // A collection: read its first face.
    let base = if bytes.get(0..4)? == b"ttcf" {
        u32_at(12)? as usize
    } else {
        0
    };
    let n = u16_at(base + 4)? as usize;
    let table = |tag: &[u8; 4]| -> Option<usize> {
        (0..n).find_map(|i| {
            let rec = base + 12 + i * 16;
            (bytes.get(rec..rec + 4)? == tag).then(|| u32_at(rec + 8).map(|o| o as usize))?
        })
    };
    let upem = u16_at(table(b"head")? + 18)? as f32;
    if upem <= 0.0 {
        return None;
    }
    let asc = table(b"OS/2")
        .and_then(|o| u16_at(o + 68))
        .or_else(|| table(b"hhea").and_then(|o| u16_at(o + 4)))? as i16;
    Some(asc as f32 / upem)
}

/// `t` as text frames, or why it is outlined instead.
pub(super) fn plain_text(
    t: &usvg::Text,
    ts: Affine,
    fonts: &[ImportFont<'_>],
) -> Result<Vec<Line>, &'static str> {
    let [a, b, c, d, ..] = ts.0;
    if b.abs() > 1e-6 || c.abs() > 1e-6 || a <= 0.0 || (a - d).abs() > 1e-4 * a {
        return Err("rotated, skewed or unevenly scaled text is imported as outlines");
    }
    let k = a;
    if t.writing_mode() != usvg::WritingMode::LeftToRight {
        return Err("vertical text is imported as outlines");
    }
    if t.rotate().iter().any(|r| r.abs() > 1e-6)
        || t.dx().iter().any(|v| v.abs() > 1e-6)
        || t.dy().iter().any(|v| v.abs() > 1e-6)
    {
        return Err("text with per-glyph positions or rotation is imported as outlines");
    }
    let bbox = t.bounding_box();
    let width = bbox.width() * k;
    let (mut last_x, mut last_y) = (0.0f32, 0.0f32);
    let mut lines = Vec::new();
    for chunk in t.chunks() {
        if !matches!(chunk.text_flow(), usvg::TextFlow::Linear) {
            return Err("text on a path is imported as outlines");
        }
        let text = chunk.text();
        let mut runs = Vec::new();
        let mut max_size = 0.0f32;
        let mut ascent = 0.0f32;
        for span in chunk.spans() {
            if !span.is_visible() {
                return Err("text with hidden spans is imported as outlines");
            }
            if span.stroke().is_some() {
                return Err("stroked text is imported as outlines");
            }
            if !span.baseline_shift().is_empty()
                || span.small_caps()
                || span.word_spacing().abs() > 1e-6
                || span.text_length().is_some()
                || span.decoration().overline().is_some()
            {
                return Err("text with a baseline shift, small caps, word spacing, a set length or an overline is imported as outlines");
            }
            let fill = match span.fill() {
                None => None,
                Some(f) => match f.paint() {
                    usvg::Paint::Color(c) if f.opacity().get() >= 1.0 => Some(*c),
                    _ => return Err(
                        "text with a gradient, pattern or translucent fill is imported as outlines",
                    ),
                },
            };
            let font = span.font();
            let Some(family) = resolve_family(font.families(), fonts) else {
                return Err("text in a font the document does not have is imported as outlines");
            };
            let size = span.font_size().get() * k;
            if size > max_size {
                max_size = size;
                ascent = fonts
                    .iter()
                    .find(|f| f.family == family)
                    .and_then(|f| ascent_em(f.bytes))
                    .unwrap_or(0.8);
            }
            let start = text[..span.start().min(text.len())].chars().count() as u32;
            let end = text[..span.end().min(text.len())].chars().count() as u32;
            runs.push(Run {
                start,
                end,
                family,
                style: style_name(font),
                size,
                fill,
                tracking: span.letter_spacing() / span.font_size().get() * 1000.0,
                underline: span.decoration().underline().is_some(),
                strike: span.decoration().line_through().is_some(),
            });
        }
        if runs.is_empty() || text.trim().is_empty() {
            continue;
        }
        let x = chunk.x().unwrap_or(last_x);
        let y = chunk.y().unwrap_or(last_y);
        (last_x, last_y) = (x, y);
        let [px, py] = ts.apply([x, y]);
        // Wider than the text so a face whose metrics differ a little
        // from usvg's layout does not wrap the line.
        let w = width * 1.15 + max_size * 2.0;
        let (left, justification) = match chunk.anchor() {
            usvg::TextAnchor::Start => (px, None),
            usvg::TextAnchor::Middle => (px - w / 2.0, Some("CenterAlign")),
            usvg::TextAnchor::End => (px - w, Some("RightAlign")),
        };
        let top = py - ascent * max_size;
        lines.push(Line {
            text: text.to_string(),
            top,
            left,
            bottom: top + max_size * 1.5,
            right: left + w,
            justification,
            runs,
        });
    }
    Ok(lines)
}
