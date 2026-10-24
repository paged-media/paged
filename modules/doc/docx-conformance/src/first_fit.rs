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

//! Word's line breaking and a picture's line, asked of Word (engine ADR 1016,
//! doc ADR 617). `scripts/word-first-fit-probe.sh` has Word export
//! [`first_fit_docx`] as PDF; `fixtures/first-fit.word.json` records every
//! line Word set: its words and where they stand.
//!
//! The text is Courier New 10 pt, a face Word has and whose every glyph
//! advances 1229/2048 em, so a line's natural width is its character count
//! times [`CHAR_PT`], whatever machine reads the answer. Each case sets its
//! measure with a right indent a few tenths of a point either side of a word
//! end (twips round it; [`FirstFitCase::measure_pt`] is the value Word got),
//! so whether a word fits is never a question of font metrics.

use crate::zip_parts;

/// The advance of every Courier New glyph at 10 pt (1229/2048 em).
pub const CHAR_PT: f32 = 1229.0 / 2048.0 * 10.0;
/// The page: US Letter with 1 in margins, a 468 pt measure before indents.
pub const FIRST_FIT_FULL_MEASURE_PT: f32 = 468.0;

/// `w:spacing w:line` and `w:lineRule`.
type Spacing = Option<(u32, &'static str)>;

/// One paragraph of [`first_fit_docx`].
#[derive(Debug, Clone, PartialEq)]
pub struct FirstFitCase {
    /// The first word of the paragraph.
    pub label: String,
    /// `left` or `both` (Word's justified).
    pub align: &'static str,
    /// The paragraph's text; an inline picture stands at the U+FFFC.
    pub text: String,
    /// The line measure after the right indent, pt.
    pub measure_pt: f32,
    /// `w:spacing w:line` and `w:lineRule`; `None` is single spacing.
    pub spacing: Option<(u32, &'static str)>,
    /// The inline picture's width and height, pt, at the U+FFFC.
    pub picture: Option<(f32, f32)>,
    /// What the case asks.
    pub note: &'static str,
}

impl FirstFitCase {
    /// The right indent in twips that gives [`Self::measure_pt`].
    fn right_indent_twips(&self) -> i64 {
        ((FIRST_FIT_FULL_MEASURE_PT - self.measure_pt) * 20.0).round() as i64
    }
}

/// The natural width of `s` in Courier New 10 pt.
fn width(s: &str) -> f32 {
    s.chars().count() as f32 * CHAR_PT
}

/// A measure `delta` pt past the end of `prefix`, rounded to whole twips
/// of right indent (the value Word lays out).
fn measure_after(prefix: &str, delta: f32) -> f32 {
    let want = width(prefix) + delta;
    let twips = ((FIRST_FIT_FULL_MEASURE_PT - want) * 20.0).round();
    FIRST_FIT_FULL_MEASURE_PT - twips / 20.0
}

/// `n` words of `len` letters, cycling through the alphabet.
fn words(n: usize, len: usize) -> Vec<String> {
    (0..n)
        .map(|i| {
            let c = (b'a' + (i % 26) as u8) as char;
            std::iter::repeat_n(c, len).collect()
        })
        .collect()
}

/// `label` then `words`, the text up to and including word `k` (0 is the
/// label), and the whole text.
fn sentence(label: &str, words: &[String], k: usize) -> (String, String) {
    let mut all = vec![label.to_string()];
    all.extend(words.iter().cloned());
    (all[..=k].join(" "), all.join(" "))
}

/// The cases of [`first_fit_docx`], in document order.
pub fn first_fit_cases() -> Vec<FirstFitCase> {
    let mut out = Vec::new();
    let mut case = |label: &str,
                    align: &'static str,
                    text: String,
                    measure_pt: f32,
                    spacing: Option<(u32, &'static str)>,
                    picture: Option<(f32, f32)>,
                    note: &'static str| {
        out.push(FirstFitCase {
            label: label.into(),
            align,
            text,
            measure_pt,
            spacing,
            picture,
            note,
        })
    };

    // Ragged: where a word fits.
    let w4 = words(16, 4);
    for (label, delta, note) in [
        ("R01", 0.3, "the 9th word ends 0.3 pt inside the measure"),
        ("R02", -0.3, "the 9th word ends 0.3 pt past the measure"),
        ("R03", 0.0, "the 9th word ends on the measure"),
        ("R04", 3.0, "the 9th word fits, the space after it does not"),
    ] {
        let (head, all) = sentence(label, &w4, 9);
        case(
            label,
            "left",
            all,
            measure_after(&head, delta),
            None,
            None,
            note,
        );
    }

    // Justified: whether Word compresses word spaces to keep a word.
    let w2 = words(30, 2);
    for (label, delta, note) in [
        (
            "J01",
            -0.5,
            "the 15th word ends 0.5 pt past the measure (15 spaces)",
        ),
        ("J02", -3.0, "3 pt past"),
        ("J03", -8.0, "8 pt past"),
        ("J04", -15.0, "15 pt past (1 pt a space)"),
        ("J05", 0.3, "the 15th word ends 0.3 pt inside"),
    ] {
        let (head, all) = sentence(label, &w2, 15);
        case(
            label,
            "both",
            all,
            measure_after(&head, delta),
            None,
            None,
            note,
        );
    }

    // Breaks inside a word: after a hyphen, a dash, a slash.
    let lead = "aaaa bbbb cccc dddd eeee";
    let tail = "ffff gggg hhhh iiii jjjj kkkk";
    for (label, align, word, head, note) in [
        (
            "H01",
            "left",
            "well-known",
            "well-",
            "the measure ends inside known",
        ),
        (
            "H02",
            "left",
            "well-known",
            "well",
            "the hyphen does not fit",
        ),
        ("H03", "left", "1990\u{2013}2000", "1990\u{2013}", "en dash"),
        ("H04", "left", "word\u{2014}word", "word\u{2014}", "em dash"),
        ("H05", "left", "and/or", "and/", "slash"),
        ("H06", "both", "well-known", "well-", "hyphen, justified"),
        ("H07", "left", "x-ray", "x-", "a one-letter prefix"),
        ("H08", "left", "page-12", "page-", "digits after the hyphen"),
    ] {
        let text = format!("{label} {lead} {word} {tail}");
        let m = measure_after(&format!("{label} {lead} {head}"), 0.3);
        case(label, align, text, m, None, None, note);
    }

    // A word wider than the measure.
    let long_x: String = std::iter::repeat_n('x', 100).collect();
    case(
        "L01",
        "left",
        format!("L01 aa {long_x} bb cc"),
        FIRST_FIT_FULL_MEASURE_PT,
        None,
        None,
        "a 100-character word after a short one",
    );
    let long_y: String = std::iter::repeat_n('y', 97).collect();
    case(
        "L02",
        "left",
        format!("L02{long_y} bb cc"),
        FIRST_FIT_FULL_MEASURE_PT,
        None,
        None,
        "a 100-character word starting the paragraph",
    );

    // An inline picture in its line, under each line rule. Every picture
    // paragraph is followed by a three-line text paragraph in the same rule
    // (the `n` label), the pitch to compare with.
    let narrow = 120.0;
    type PicCase = (&'static str, Spacing, (f32, f32), &'static str);
    let pic_cases: [PicCase; 7] = [
        ("P01", None, (20.0, 40.0), "single spacing, a 40 pt picture"),
        ("P02", Some((360, "auto")), (20.0, 40.0), "1.5 lines"),
        (
            "P03",
            Some((280, "atLeast")),
            (20.0, 40.0),
            "at least 14 pt",
        ),
        ("P04", Some((280, "exact")), (20.0, 40.0), "exactly 14 pt"),
        ("P05", None, (20.0, 4.0), "single spacing, a 4 pt picture"),
        (
            "P06",
            None,
            (20.0, 40.0),
            "single, the picture on the 2nd line",
        ),
        (
            "P07",
            Some((360, "auto")),
            (20.0, 40.0),
            "1.5 lines, the picture on the 2nd line",
        ),
    ];
    for (label, spacing, pic, note) in pic_cases {
        let text = if label == "P06" || label == "P07" {
            format!("{label}a aaaa bbbb cccc {label}b dd \u{FFFC} ee {label}c ffff gggg hhhh")
        } else {
            format!("{label}a \u{FFFC} {label}b")
        };
        case(label, "left", text, narrow, spacing, Some(pic), note);
        let n = format!("{label}n");
        case(
            &n,
            "left",
            format!("{n} aaaa bbbb cccc {label}m dddd eeee ffff {label}o gggg hhhh"),
            narrow,
            spacing,
            None,
            "the text pitch of the case above",
        );
    }
    out
}

const PNG_1X1: &[u8] = &[
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0xda, 0x63, 0x64, 0x60, 0xf8, 0x5f,
    0x0f, 0x00, 0x02, 0x87, 0x01, 0x80, 0xeb, 0x47, 0xba, 0x92, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45,
    0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
];

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn inline_picture(id: usize, w_pt: f32, h_pt: f32) -> String {
    let (cx, cy) = ((w_pt * 12700.0) as i64, (h_pt * 12700.0) as i64);
    format!(
        r#"<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="{cx}" cy="{cy}"/><wp:docPr id="{id}" name="Picture {id}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="{id}" name="image1.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdImg"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>"#
    )
}

/// The first-fit probe document: [`first_fit_cases`], one paragraph each,
/// no space between paragraphs, in Word 2013+ layout (`compatibilityMode`
/// 15). The picture cases start page 2.
pub fn first_fit_docx() -> Vec<u8> {
    let mut body = String::new();
    for (i, c) in first_fit_cases().iter().enumerate() {
        let pbb = if c.label == "P01" {
            "<w:pageBreakBefore/>"
        } else {
            ""
        };
        let spacing = match c.spacing {
            Some((line, rule)) => format!(r#"<w:spacing w:line="{line}" w:lineRule="{rule}"/>"#),
            None => String::new(),
        };
        let ind = format!(r#"<w:ind w:right="{}"/>"#, c.right_indent_twips());
        let run = |t: &str| {
            format!(
                r#"<w:r><w:t xml:space="preserve">{}</w:t></w:r>"#,
                xml_escape(t)
            )
        };
        let runs = match (c.picture, c.text.split_once('\u{FFFC}')) {
            (Some((w, h)), Some((before, after))) => {
                format!(
                    "{}{}{}",
                    run(before),
                    inline_picture(i + 1, w, h),
                    run(after)
                )
            }
            _ => run(&c.text),
        };
        body.push_str(&format!(
            r#"<w:p><w:pPr>{pbb}{spacing}{ind}<w:jc w:val="{}"/></w:pPr>{runs}</w:p>"#,
            c.align
        ));
    }
    let document = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>{body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body>
</w:document>"#
    );
    let styles = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault><w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New" w:eastAsia="Courier New"/><w:sz w:val="20"/><w:szCs w:val="20"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault>
    <w:pPrDefault><w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
</w:styles>"#;
    let settings = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat>
</w:settings>"#;
    let content_types = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>
</Types>"#;
    let doc_rels = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>
  <Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>
</Relationships>"#;
    let root_rels = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"#;
    zip_parts(&[
        ("[Content_Types].xml", content_types.as_bytes()),
        ("_rels/.rels", root_rels.as_bytes()),
        ("word/_rels/document.xml.rels", doc_rels.as_bytes()),
        ("word/document.xml", document.as_bytes()),
        ("word/styles.xml", styles.as_bytes()),
        ("word/settings.xml", settings.as_bytes()),
        ("word/media/image1.png", PNG_1X1),
    ])
}

/// [`first_fit_cases`] as JSON, for the probe script to record next to
/// Word's lines (the crate carries no serde).
pub fn first_fit_cases_json() -> String {
    let esc = |s: &str| {
        let mut o = String::new();
        for c in s.chars() {
            match c {
                '"' => o.push_str("\\\""),
                '\\' => o.push_str("\\\\"),
                c if (c as u32) < 0x20 || (c as u32) > 0x7e => {
                    o.push_str(&format!("\\u{:04x}", c as u32))
                }
                c => o.push(c),
            }
        }
        o
    };
    let rows: Vec<String> = first_fit_cases()
        .iter()
        .map(|c| {
            let spacing = match c.spacing {
                Some((line, rule)) => format!(r#"{{"line":{line},"rule":"{rule}"}}"#),
                None => "null".into(),
            };
            let picture = match c.picture {
                Some((w, h)) => format!("[{w},{h}]"),
                None => "null".into(),
            };
            format!(
                r#"{{"label":"{}","align":"{}","text":"{}","measure_pt":{},"spacing":{spacing},"picture":{picture},"note":"{}"}}"#,
                esc(&c.label),
                c.align,
                esc(&c.text),
                c.measure_pt,
                esc(c.note)
            )
        })
        .collect();
    format!("[{}]", rows.join(","))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_measures_sit_either_side_of_a_word_end() {
        let cases = first_fit_cases();
        let r01 = cases.iter().find(|c| c.label == "R01").unwrap();
        let head = "R01 aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii";
        assert!((r01.measure_pt - width(head) - 0.3).abs() <= 0.03);
        let r02 = cases.iter().find(|c| c.label == "R02").unwrap();
        assert!(r02.measure_pt < width(head));
        assert!(first_fit_docx().len() > 1000);
        assert!(first_fit_cases_json().starts_with("[{"));
    }
}
