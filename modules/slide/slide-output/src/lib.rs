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

//! The deck's printed and text outputs (slide ADR 720):
//!
//! * the **outline** (PowerPoint's File ▸ Export ▸ Outline/RTF): each
//!   slide's title and its body placeholders' paragraphs by list level, as
//!   RTF ([`outline_rtf`]) or plain text ([`outline_txt`]);
//! * the **PDF** of the slides, handouts (1, 2, 3, 4, 6 or 9 slides a page,
//!   three with lines for notes) and notes pages ([`pdf`]).
//!
//! Nothing here reads PresentationML or the engine's model: the outline is
//! gathered by `pptx-export` from the document, the slide images come from
//! the host's renderer. This crate lays them out and writes the bytes.

use serde::{Deserialize, Serialize};

mod helvetica;
pub mod pdf;

/// One slide of the outline.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct OutlineSlide {
    /// The title placeholder's text, its paragraphs joined by a space.
    pub title: String,
    /// The body placeholders' paragraphs: list level (0-based) and text.
    pub body: Vec<(usize, String)>,
}

/// The outline as plain text: each slide's title on a line of its own, its
/// body indented one tab per level, a blank line between slides.
pub fn outline_txt(slides: &[OutlineSlide]) -> String {
    let mut out = String::new();
    for (i, s) in slides.iter().enumerate() {
        if i > 0 {
            out.push('\n');
        }
        out.push_str(&one_line(&s.title));
        out.push('\n');
        for (level, text) in &s.body {
            for _ in 0..=*level {
                out.push('\t');
            }
            out.push_str(&one_line(text));
            out.push('\n');
        }
    }
    out
}

/// A paragraph's line breaks as spaces.
fn one_line(s: &str) -> String {
    s.replace(['\n', '\r', '\u{2028}', '\u{2029}', '\u{b}'], " ")
}

/// RTF's escape of `s`: the control characters, then everything outside
/// ASCII as `\uN?` (UTF-16 units, signed), so any script survives.
fn rtf_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in one_line(s).chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '{' => out.push_str("\\{"),
            '}' => out.push_str("\\}"),
            '\t' => out.push_str("\\tab "),
            c if c.is_ascii() && !c.is_ascii_control() => out.push(c),
            c if c.is_ascii() => {}
            c => {
                let mut units = [0u16; 2];
                for u in c.encode_utf16(&mut units) {
                    out.push_str(&format!("\\u{}?", *u as i16));
                }
            }
        }
    }
    out
}

/// The outline as RTF, the way PowerPoint writes it for Word: each title an
/// outline level 1 heading (bold, 22 pt), each body paragraph an outline
/// level below it (16 pt, indented a quarter inch per level), so Word's
/// outline view and a re-import into PowerPoint read the same structure.
pub fn outline_rtf(slides: &[OutlineSlide]) -> String {
    let mut out = String::from(
        "{\\rtf1\\ansi\\ansicpg1252\\deff0\\uc1{\\fonttbl{\\f0\\fswiss\\fcharset0 Helvetica;}}\n",
    );
    for s in slides {
        out.push_str(&format!(
            "\\pard\\plain\\outlinelevel0\\sb240\\f0\\fs44\\b {}\\b0\\par\n",
            rtf_text(&s.title)
        ));
        for (level, text) in &s.body {
            let level = (*level).min(8);
            out.push_str(&format!(
                "\\pard\\plain\\outlinelevel{}\\li{}\\f0\\fs32 {}\\par\n",
                level + 1,
                360 * (level + 1),
                rtf_text(text)
            ));
        }
    }
    out.push('}');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn deck() -> Vec<OutlineSlide> {
        vec![
            OutlineSlide {
                title: "Quarterly {review}".into(),
                body: vec![(0, "Revenue \\ up".into()), (1, "Österreich: +12 %".into())],
            },
            OutlineSlide {
                title: "Next steps 🚀".into(),
                body: vec![],
            },
        ]
    }

    #[test]
    fn the_text_outline_indents_by_level() {
        assert_eq!(
            outline_txt(&deck()),
            "Quarterly {review}\n\tRevenue \\ up\n\t\tÖsterreich: +12 %\n\nNext steps 🚀\n"
        );
    }

    #[test]
    fn the_rtf_outline_escapes_and_levels() {
        let r = outline_rtf(&deck());
        assert!(r.starts_with("{\\rtf1\\ansi"));
        assert!(r.ends_with('}'));
        assert_eq!(
            r.matches('{').count() - r.matches("\\{").count(),
            r.matches('}').count() - r.matches("\\}").count()
        );
        assert!(r.contains("\\outlinelevel0\\sb240\\f0\\fs44\\b Quarterly \\{review\\}\\b0\\par"));
        assert!(r.contains("\\outlinelevel1\\li360\\f0\\fs32 Revenue \\\\ up\\par"));
        // Ö is U+00D6 = 214; the rocket is a surrogate pair.
        assert!(r.contains("\\outlinelevel2\\li720\\f0\\fs32 \\u214?sterreich"));
        assert!(r.contains("\\u-10179?\\u-8576?"));
    }
}
