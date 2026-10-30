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

//! Doc ADR 614 (content controls) — save-back of an inline content
//! control's value. The canvas sets a control's value as one run (engine
//! ADR 1052); the text patcher leaves a control's runs alone (they are
//! locked), so a changed control is taken out of the read-back here and
//! written into its `w:sdt` directly: the `w:sdtPr` keeps every byte but
//! the state that changed (`w14:checked`, `w:lastValue`, `w:fullDate`,
//! `w:showingPlcHdr`), and the `w:sdtContent` becomes one run in the
//! control's first run's look, holding the value's text.

use docx_lower::ir::{LoweredBlock, LoweredDoc, LoweredParagraph, LoweredRun};
use quick_xml::escape::escape;

use crate::overlay::{ControlIn, RunContentIn, StoryContentIn};

/// A control whose value the canvas changed.
#[derive(Debug, Clone, PartialEq)]
pub struct ControlChange {
    /// Word's `w:id`.
    pub word_id: i32,
    /// The text the control now shows.
    pub text: String,
    pub showing_placeholder: bool,
    pub was_placeholder: bool,
    pub checked: Option<bool>,
    /// A drop-down's chosen value, a date's `YYYY-MM-DD`.
    pub value: Option<String>,
    pub kind: String,
}

fn paragraphs(doc: &LoweredDoc) -> impl Iterator<Item = &LoweredParagraph> {
    doc.story.blocks.iter().filter_map(|b| match b {
        LoweredBlock::Paragraph(p) => Some(p),
        _ => None,
    })
}

/// The baseline runs of control `id`.
fn baseline_runs<'a>(doc: &'a LoweredDoc, id: &str) -> Vec<&'a LoweredRun> {
    paragraphs(doc)
        .flat_map(|p| &p.runs)
        .filter(|r| r.control.as_ref().is_some_and(|c| c.id == id))
        .collect()
}

/// Take the changed controls out of `content`: each one's read-back runs
/// are put back as the baseline's (so the text patcher sees no change in
/// them), and the change is returned for [`save_controls`]. A control the
/// baseline does not know, or one without Word's id, is left as it is.
pub fn take_control_changes(
    content: &mut StoryContentIn,
    baseline: &LoweredDoc,
) -> Vec<ControlChange> {
    let mut out = Vec::new();
    for para in &mut content.paragraphs {
        let mut i = 0;
        while i < para.runs.len() {
            let Some(id) = para.runs[i].control.as_ref().map(|c| c.id.clone()) else {
                i += 1;
                continue;
            };
            let mut j = i + 1;
            while j < para.runs.len() && para.runs[j].control.as_ref().is_some_and(|c| c.id == id) {
                j += 1;
            }
            let base = baseline_runs(baseline, &id);
            let Some(first) = base.first().and_then(|r| r.control.as_ref()) else {
                i = j;
                continue;
            };
            let text: String = para.runs[i..j].iter().map(|r| r.text.as_str()).collect();
            let base_text: String = base.iter().map(|r| r.text.as_str()).collect();
            let now: &ControlIn = para.runs[i].control.as_ref().expect("a control run");
            let (base_checked, base_value) = state_of(&first.kind);
            let changed = text != base_text
                || now.showing_placeholder != first.showing_placeholder
                || now.checked != base_checked
                || now.value != base_value;
            let Some(word_id) = first.word_id() else {
                i = j;
                continue;
            };
            if !changed {
                i = j;
                continue;
            }
            out.push(ControlChange {
                word_id,
                text,
                showing_placeholder: now.showing_placeholder,
                was_placeholder: first.showing_placeholder,
                checked: now.checked,
                value: now.value.clone(),
                kind: now.kind.clone(),
            });
            let restored: Vec<RunContentIn> = base
                .iter()
                .map(|r| RunContentIn {
                    text: r.text.clone(),
                    character_style: r.char_style_id.clone(),
                    control: Some(now.clone()),
                    ..Default::default()
                })
                .collect();
            let n = restored.len();
            para.runs.splice(i..j, restored);
            i += n;
        }
    }
    out
}

fn state_of(kind: &docx_core::ContentControlKind) -> (Option<bool>, Option<String>) {
    use docx_core::ContentControlKind as K;
    match kind {
        K::Checkbox { checked, .. } => (Some(*checked), None),
        K::DropDown { value, .. } | K::Date { value, .. } => (None, value.clone()),
        _ => (None, None),
    }
}

/// Write each change into its `w:sdt` of the main part. Returns the
/// changes it could not place (their control not found), as refusals.
pub fn save_controls(xml: &[u8], changes: &[ControlChange]) -> (Vec<u8>, Vec<String>) {
    let mut bytes = xml.to_vec();
    let mut skips = Vec::new();
    for c in changes {
        match rewrite_sdt(&bytes, c) {
            Some(next) => bytes = next,
            None => skips.push(format!(
                "content control w:id {} not found in the document; its value was not saved",
                c.word_id
            )),
        }
    }
    (bytes, skips)
}

fn find(hay: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    hay.get(from..)?
        .windows(needle.len())
        .position(|w| w == needle)
        .map(|p| p + from)
}

fn rfind(hay: &[u8], needle: &[u8], before: usize) -> Option<usize> {
    hay[..before]
        .windows(needle.len())
        .rposition(|w| w == needle)
}

/// The start of the `<w:sdt>` element whose `w:sdtPr` holds `w:id` `id`.
fn sdt_start(xml: &[u8], id: i32) -> Option<usize> {
    let needle = format!("w:val=\"{id}\"");
    let mut from = 0;
    while let Some(at) = find(xml, needle.as_bytes(), from) {
        from = at + 1;
        let tag = rfind(xml, b"<", at)?;
        let name_end = tag
            + 1
            + xml[tag + 1..]
                .iter()
                .position(|b| *b == b' ' || *b == b'/')?;
        if &xml[tag + 1..name_end] != b"w:id" {
            continue;
        }
        // Its `w:sdtPr`'s `w:sdt`.
        let pr = rfind(xml, b"<w:sdtPr", tag)?;
        let sdt = rfind(xml, b"<w:sdt", pr)?;
        if matches!(xml.get(sdt + 6), Some(b'>' | b' ')) {
            return Some(sdt);
        }
    }
    None
}

/// The byte range of the matching end of the element starting at `start`
/// named `name` (`<w:sdtContent` …): from `start` to past its end tag,
/// counting nested elements of the same name.
fn element_end(xml: &[u8], start: usize, name: &[u8]) -> Option<usize> {
    let open: Vec<u8> = [b"<".as_slice(), name].concat();
    let close: Vec<u8> = [b"</".as_slice(), name, b">"].concat();
    let mut depth = 0usize;
    let mut at = start;
    loop {
        let o = find(xml, &open, at);
        let c = find(xml, &close, at)?;
        match o {
            Some(o) if o < c && matches!(xml.get(o + open.len()), Some(b'>' | b' ' | b'/')) => {
                // A self-closing element does not nest.
                let gt = find(xml, b">", o)?;
                if xml[gt - 1] != b'/' {
                    depth += 1;
                }
                at = gt + 1;
            }
            Some(o) if o < c => at = o + open.len(),
            _ => {
                depth = depth.checked_sub(1)?;
                at = c + close.len();
                if depth == 0 {
                    return Some(at);
                }
            }
        }
    }
}

/// Set (or add) attribute `attr` on the first `<elem` tag inside `pr`.
fn set_attr(pr: &mut Vec<u8>, elem: &[u8], attr: &str, value: &str) -> bool {
    let Some(tag) = find(pr, elem, 0) else {
        return false;
    };
    let Some(gt) = find(pr, b">", tag) else {
        return false;
    };
    let head = &pr[tag..gt];
    let key = format!(" {attr}=\"");
    if let Some(k) = find(head, key.as_bytes(), 0) {
        let vstart = tag + k + key.len();
        let Some(vend) = find(pr, b"\"", vstart) else {
            return false;
        };
        pr.splice(vstart..vend, escape(value).as_bytes().iter().copied());
    } else {
        let insert_at = if pr[gt - 1] == b'/' { gt - 1 } else { gt };
        let add = format!(" {attr}=\"{}\"", escape(value));
        pr.splice(insert_at..insert_at, add.into_bytes());
    }
    true
}

fn rewrite_sdt(xml: &[u8], c: &ControlChange) -> Option<Vec<u8>> {
    let sdt = sdt_start(xml, c.word_id)?;
    let pr_start = find(xml, b"<w:sdtPr", sdt)?;
    let pr_end = element_end(xml, pr_start, b"w:sdtPr")?;
    let content_start = find(xml, b"<w:sdtContent", pr_end)?;
    let content_end = element_end(xml, content_start, b"w:sdtContent")?;
    let mut pr = xml[pr_start..pr_end].to_vec();
    // The placeholder goes with the first value.
    if !c.showing_placeholder {
        for form in [
            b"<w:showingPlcHdr/>".as_slice(),
            b"<w:showingPlcHdr />".as_slice(),
        ] {
            if let Some(at) = find(&pr, form, 0) {
                pr.drain(at..at + form.len());
            }
        }
    }
    match c.kind.as_str() {
        "checkbox" => {
            if let Some(on) = c.checked {
                set_attr(
                    &mut pr,
                    b"<w14:checked",
                    "w14:val",
                    if on { "1" } else { "0" },
                );
            }
        }
        "dropDown" => {
            if let Some(v) = &c.value {
                set_attr(&mut pr, b"<w:dropDownList", "w:lastValue", v);
            }
        }
        "comboBox" => {
            if let Some(v) = &c.value {
                set_attr(&mut pr, b"<w:comboBox", "w:lastValue", v);
            }
        }
        "date" => {
            if let Some(v) = &c.value {
                set_attr(&mut pr, b"<w:date", "w:fullDate", &format!("{v}T00:00:00Z"));
            }
        }
        _ => {}
    }
    // The content: one run in the first run's look.
    let content = &xml[content_start..content_end];
    let open_end = find(content, b">", 0)? + 1;
    let open_tag = &content[..open_end];
    let rpr = find(content, b"<w:r>", 0)
        .or_else(|| find(content, b"<w:r ", 0))
        .and_then(|r| {
            let r_end = find(content, b"</w:r>", r)?;
            let s = find(&content[..r_end], b"<w:rPr", r)?;
            let e = element_end(content, s, b"w:rPr")?;
            Some(content[s..e].to_vec())
        })
        .map(|mut rpr| {
            if c.was_placeholder && !c.showing_placeholder {
                if let Some(s) = find(&rpr, b"<w:rStyle", 0) {
                    if let Some(e) = find(&rpr, b"/>", s) {
                        rpr.drain(s..e + 2);
                    }
                }
                if rpr == b"<w:rPr></w:rPr>" {
                    rpr.clear();
                }
            }
            rpr
        })
        .unwrap_or_default();
    let mut body = Vec::new();
    body.extend_from_slice(open_tag);
    body.extend_from_slice(b"<w:r>");
    body.extend_from_slice(&rpr);
    body.extend_from_slice(b"<w:t xml:space=\"preserve\">");
    body.extend_from_slice(escape(c.text.as_str()).as_bytes());
    body.extend_from_slice(b"</w:t></w:r></w:sdtContent>");
    let mut out = Vec::with_capacity(xml.len() + 64);
    out.extend_from_slice(&xml[..pr_start]);
    out.extend_from_slice(&pr);
    out.extend_from_slice(&xml[pr_end..content_start]);
    out.extend_from_slice(&body);
    out.extend_from_slice(&xml[content_end..]);
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const XML: &str = r#"<w:p><w:sdt><w:sdtPr><w:alias w:val="Agree"/><w:id w:val="7"/><w14:checkbox><w14:checked w14:val="0"/><w14:checkedState w14:val="2612" w14:font="MS Gothic"/></w14:checkbox></w:sdtPr><w:sdtContent><w:r><w:rPr><w:rFonts w:ascii="MS Gothic" w:hAnsi="MS Gothic"/></w:rPr><w:t>☐</w:t></w:r></w:sdtContent></w:sdt><w:sdt><w:sdtPr><w:id w:val="8"/><w:showingPlcHdr/><w:date w:fullDate="2026-01-02T00:00:00Z"><w:dateFormat w:val="d MMMM yyyy"/></w:date></w:sdtPr><w:sdtContent><w:r><w:rPr><w:rStyle w:val="PlaceholderText"/></w:rPr><w:t>Click</w:t></w:r></w:sdtContent></w:sdt></w:p>"#;

    #[test]
    fn a_checkbox_and_a_date_are_written_into_their_sdt() {
        let changes = [
            ControlChange {
                word_id: 7,
                text: "☒".into(),
                showing_placeholder: false,
                was_placeholder: false,
                checked: Some(true),
                value: None,
                kind: "checkbox".into(),
            },
            ControlChange {
                word_id: 8,
                text: "30 October 2026".into(),
                showing_placeholder: false,
                was_placeholder: true,
                checked: None,
                value: Some("2026-10-30".into()),
                kind: "date".into(),
            },
        ];
        let (out, skips) = save_controls(XML.as_bytes(), &changes);
        assert!(skips.is_empty());
        let out = String::from_utf8(out).unwrap();
        assert!(out.contains(r#"<w14:checked w14:val="1"/>"#), "{out}");
        assert!(out.contains(r#"<w14:checkedState w14:val="2612" w14:font="MS Gothic"/>"#));
        assert!(out.contains(r#"<w:rFonts w:ascii="MS Gothic" w:hAnsi="MS Gothic"/></w:rPr><w:t xml:space="preserve">☒</w:t>"#), "{out}");
        assert!(
            out.contains(r#"w:fullDate="2026-10-30T00:00:00Z""#),
            "{out}"
        );
        assert!(!out.contains("showingPlcHdr"), "{out}");
        assert!(!out.contains("PlaceholderText"), "{out}");
        assert!(out.contains("30 October 2026"));
        // What did not change keeps its bytes.
        assert!(
            out.starts_with(r#"<w:p><w:sdt><w:sdtPr><w:alias w:val="Agree"/><w:id w:val="7"/>"#)
        );
        let (_, skips) = save_controls(
            XML.as_bytes(),
            &[ControlChange {
                word_id: 99,
                ..changes[0].clone()
            }],
        );
        assert_eq!(skips.len(), 1);
    }
}
