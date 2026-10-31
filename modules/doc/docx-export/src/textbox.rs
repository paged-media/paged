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

//! Doc ADR 614 — save-back of text boxes placed as page items. A box's
//! story is read back as a header's is (doc ADR 611); an edit is spliced
//! into its `w:txbxContent` with the body's machinery: the box's content is
//! cut out of its part, wrapped as a small part whose root holds paragraphs
//! as `w:body` does, diffed and patched there, and put back in place. Every
//! other byte of the part is untouched; an unedited box changes nothing.
//!
//! Where Word wrote the box twice (an `mc:AlternateContent` whose
//! `mc:Fallback` repeats it in VML), the fallback's copy is patched the
//! same way when its paragraphs say what the box said; otherwise the
//! refusal ledger names it.

use docx_core::{Block, DocxDocument, Paragraph, TextBox};
use docx_lower::ir::{LoweredBlock, LoweredDoc, LoweredItemKind, LoweredParagraph};
use paged_ooxml::{OoxmlError, OpcPackage};
use quick_xml::events::Event;
use quick_xml::Reader;
use serde::{Deserialize, Serialize};

use crate::bindings::build_bindings;
use crate::overlay::{overlay_story_content_with, StoryContentIn, TableParagraphs};
use crate::{apply_edits, diff};

/// A text box's story read back: the page item's id and its content.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextBoxIn {
    pub item: String,
    pub content: StoryContentIn,
}

/// The name the wrapped content takes in a scratch package.
const SCRATCH: &str = "word/paged-text-box.xml";

/// One `w:txbxContent` in a part: the byte range of its content (between
/// its start and end tags) and whether it stands in an `mc:Fallback`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BoxRange {
    pub start: usize,
    pub end: usize,
    pub fallback: bool,
    /// The `mc:AlternateContent` it stands in (its start offset), if any.
    pub alternate: Option<usize>,
}

/// Every `w:txbxContent` of `part`, in document order (of their start
/// tags), and the root element's namespace declarations.
pub fn box_ranges(part: &[u8]) -> (Vec<BoxRange>, String) {
    let mut reader = Reader::from_reader(part);
    let mut out: Vec<BoxRange> = Vec::new();
    // Open boxes: index into `out`.
    let mut open: Vec<usize> = Vec::new();
    let mut stack: Vec<Vec<u8>> = Vec::new();
    let mut fallback_depth: Option<usize> = None;
    let mut alternates: Vec<usize> = Vec::new();
    let mut ns = String::new();
    let mut buf = Vec::new();
    loop {
        let before = reader.buffer_position() as usize;
        let ev = reader.read_event_into(&mut buf);
        let after = reader.buffer_position() as usize;
        match ev {
            Ok(Event::Start(e)) => {
                let ln = e.local_name().as_ref().to_vec();
                if stack.is_empty() {
                    for a in e.attributes().flatten() {
                        let key = String::from_utf8_lossy(a.key.as_ref()).to_string();
                        if key == "xmlns" || key.starts_with("xmlns:") || key == "mc:Ignorable" {
                            ns.push_str(&format!(
                                " {key}=\"{}\"",
                                String::from_utf8_lossy(&a.value)
                            ));
                        }
                    }
                }
                if ln == b"AlternateContent" {
                    alternates.push(before);
                }
                if ln == b"Fallback" && fallback_depth.is_none() {
                    fallback_depth = Some(stack.len());
                }
                if ln == b"txbxContent" {
                    open.push(out.len());
                    out.push(BoxRange {
                        start: after,
                        end: after,
                        fallback: fallback_depth.is_some(),
                        alternate: alternates.last().copied(),
                    });
                }
                stack.push(ln);
            }
            Ok(Event::End(e)) => {
                let ln = e.local_name().as_ref().to_vec();
                stack.pop();
                if ln == b"txbxContent" {
                    if let Some(i) = open.pop() {
                        out[i].end = before;
                    }
                }
                if ln == b"Fallback" && fallback_depth == Some(stack.len()) {
                    fallback_depth = None;
                }
                if ln == b"AlternateContent" {
                    alternates.pop();
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    (out, ns)
}

/// The boxes the import reads, in its order: those outside an
/// `mc:Fallback` (the choice Word's readers take).
pub fn read_boxes(ranges: &[BoxRange]) -> Vec<BoxRange> {
    ranges.iter().copied().filter(|r| !r.fallback).collect()
}

/// The text box of `model` in `part` with `ordinal`, searching every body
/// paragraph (and cell paragraph) or the header / footer part's.
fn model_box<'a>(model: &'a DocxDocument, part: &str, ordinal: u32) -> Option<&'a TextBox> {
    fn in_paragraphs(ps: &[Paragraph], ordinal: u32) -> Option<&TextBox> {
        ps.iter()
            .flat_map(|p| p.runs.iter())
            .flat_map(|r| r.text_boxes.iter())
            .find(|t| t.ordinal == ordinal)
    }
    if part.ends_with("document.xml") {
        model.body.iter().find_map(|b| match b {
            Block::Paragraph(p) => in_paragraphs(std::slice::from_ref(p), ordinal),
            Block::Table(t) => t
                .rows
                .iter()
                .flat_map(|r| r.cells.iter())
                .find_map(|c| in_paragraphs(&c.paragraphs, ordinal)),
        })
    } else {
        model
            .headers_footers
            .iter()
            .filter(|h| h.part == part)
            .find_map(|h| in_paragraphs(&h.paragraphs, ordinal))
    }
}

/// The paragraphs' text, for comparing a fallback copy with the box.
fn texts(ps: &[Paragraph]) -> Vec<String> {
    ps.iter()
        .map(|p| p.runs.iter().map(|r| r.text.as_str()).collect())
        .collect()
}

/// Patch the content `range` of `part_bytes` from `base` to `edited`
/// (lowered paragraphs of the box, `source` its Word paragraphs): the new
/// content bytes, and what the patcher refused.
#[allow(clippy::too_many_arguments)]
fn patch_range(
    pkg: &OpcPackage,
    part_bytes: &[u8],
    range: BoxRange,
    ns: &str,
    model: &DocxDocument,
    lowered: &LoweredDoc,
    base: &[LoweredParagraph],
    edited: &[LoweredParagraph],
    source: &[Paragraph],
) -> Result<(Vec<u8>, Vec<String>), OoxmlError> {
    let mut wrapped =
        format!("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<w:hdr{ns}>")
            .into_bytes();
    let head = wrapped.len();
    wrapped.extend_from_slice(&part_bytes[range.start..range.end]);
    wrapped.extend_from_slice(b"</w:hdr>");
    let mut scratch = pkg.clone();
    scratch.set_part(SCRATCH, wrapped);
    let mini = |ps: &[LoweredParagraph]| LoweredDoc {
        story: docx_lower::ir::LoweredStory {
            blocks: ps.iter().cloned().map(LoweredBlock::Paragraph).collect(),
        },
        ..lowered.clone()
    };
    let doc = DocxDocument {
        body: source.iter().cloned().map(Block::Paragraph).collect(),
        styles: model.styles.clone(),
        ..Default::default()
    };
    let bindings = build_bindings(&doc);
    let edits = diff(&mini(base), &mini(edited), &bindings);
    let skips = apply_edits(&mut scratch, SCRATCH, &bindings, &edits)?;
    let out = scratch.require(SCRATCH)?;
    let tail = out.len().saturating_sub(b"</w:hdr>".len());
    // The patcher copies the prologue and the root's start tag verbatim.
    Ok((out[head.min(tail)..tail].to_vec(), skips))
}

/// The text box edits (doc ADR 614): per box, the first story read back
/// for it whose text or look differs from the box.
pub fn save_text_boxes(
    pkg: &mut OpcPackage,
    model: &DocxDocument,
    lowered: &LoweredDoc,
    boxes: &[TextBoxIn],
) -> Result<Vec<String>, OoxmlError> {
    let mut skips = Vec::new();
    let mut done: Vec<(String, u32)> = Vec::new();
    for b in boxes {
        let Some(item) = lowered.page_items.iter().find(|i| i.id == b.item) else {
            continue;
        };
        let LoweredItemKind::TextBox { paragraphs, .. } = &item.item else {
            continue;
        };
        let Some(ordinal) = item.source.ordinal else {
            continue;
        };
        let part = item.source.part.clone();
        if done.contains(&(part.clone(), ordinal)) {
            continue;
        }
        let base = LoweredDoc {
            story: docx_lower::ir::LoweredStory {
                blocks: paragraphs
                    .iter()
                    .cloned()
                    .map(LoweredBlock::Paragraph)
                    .collect(),
            },
            ..lowered.clone()
        };
        let edited =
            overlay_story_content_with(&base, &b.content, TableParagraphs::Joined, &|_| false);
        let edited_paras: Vec<LoweredParagraph> = edited
            .story
            .blocks
            .into_iter()
            .filter_map(|b| match b {
                LoweredBlock::Paragraph(p) => Some(p),
                LoweredBlock::Table(_) => None,
            })
            .collect();
        let same = edited_paras.len() == paragraphs.len()
            && edited_paras.iter().zip(paragraphs).all(|(a, b)| {
                a.runs.len() == b.runs.len()
                    && a.runs
                        .iter()
                        .zip(&b.runs)
                        .all(|(x, y)| x.text == y.text && x.char_style_id == y.char_style_id)
                    && a.para_style_id == b.para_style_id
            });
        if same {
            continue;
        }
        done.push((part.clone(), ordinal));
        if !item.source.editable {
            skips.push(format!(
                "{part}: text box {ordinal} edit refused: the box holds a table or a content \
                 control the canvas shows as text"
            ));
            continue;
        }
        let Some(source) = model_box(model, &part, ordinal) else {
            skips.push(format!(
                "{part}: text box {ordinal} not found in the import"
            ));
            continue;
        };
        let bytes = pkg.require(&part)?.to_vec();
        let (ranges, ns) = box_ranges(&bytes);
        let Some(range) = read_boxes(&ranges).get(ordinal as usize).copied() else {
            skips.push(format!("{part}: text box {ordinal} not found in the part"));
            continue;
        };
        // The fallback copy of the same box, when Word wrote one.
        let fallback = range.alternate.and_then(|alt| {
            ranges
                .iter()
                .copied()
                .find(|r| r.fallback && r.alternate == Some(alt))
        });
        let styles = edited.styles.iter().fold(lowered.clone(), |mut l, s| {
            if !l.styles.iter().any(|x| x.id == s.id) {
                l.styles.push(s.clone());
            }
            l
        });
        let (new_inner, mut box_skips) = patch_range(
            pkg,
            &bytes,
            range,
            &ns,
            model,
            &styles,
            paragraphs,
            &edited_paras,
            &source.paragraphs,
        )?;
        let mut spliced: Vec<(BoxRange, Vec<u8>)> = vec![(range, new_inner)];
        if let Some(fb) = fallback {
            // The fallback must say what the box said to take the same edit.
            let fb_doc = format!(
                "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<w:hdr{ns}>{}</w:hdr>",
                String::from_utf8_lossy(&bytes[fb.start..fb.end])
            );
            let fb_paras = fallback_paragraphs(fb_doc.as_bytes());
            if fb_paras == texts(&source.paragraphs) {
                let (fb_inner, fb_skips) = patch_range(
                    pkg,
                    &bytes,
                    fb,
                    &ns,
                    model,
                    &styles,
                    paragraphs,
                    &edited_paras,
                    &source.paragraphs,
                )?;
                box_skips.extend(fb_skips.into_iter().map(|s| format!("fallback copy: {s}")));
                spliced.push((fb, fb_inner));
            } else {
                box_skips.push(format!(
                    "text box {ordinal}: its VML fallback copy differs from the box and keeps \
                     its old text (Word reads the box)"
                ));
            }
        }
        // Splice back to front so the earlier ranges keep their offsets.
        spliced.sort_by_key(|(r, _)| std::cmp::Reverse(r.start));
        let mut out = bytes.clone();
        for (r, inner) in spliced {
            out.splice(r.start..r.end, inner);
        }
        if out != bytes {
            pkg.set_part(&part, out);
        }
        skips.extend(box_skips.into_iter().map(|s| format!("{part}: {s}")));
    }
    Ok(skips)
}

/// The text of each `w:p` that is a direct child of the root of `doc` (the
/// wrapped fallback content), joined as the import joins runs' text (`w:t`
/// only, which is what a plain box holds).
fn fallback_paragraphs(doc: &[u8]) -> Vec<String> {
    let mut reader = Reader::from_reader(doc);
    let mut out = Vec::new();
    let mut depth = 0usize;
    let mut in_t = false;
    let mut p_depth: Option<usize> = None;
    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                depth += 1;
                let ln = e.local_name();
                if ln.as_ref() == b"p" && depth == 2 {
                    p_depth = Some(depth);
                    out.push(String::new());
                }
                if ln.as_ref() == b"t" && p_depth.is_some() {
                    in_t = true;
                }
            }
            Ok(Event::Empty(e)) => {
                if e.local_name().as_ref() == b"p" && depth == 1 {
                    out.push(String::new());
                }
                if e.local_name().as_ref() == b"tab" && p_depth.is_some() {
                    if let Some(s) = out.last_mut() {
                        s.push('\t');
                    }
                }
            }
            Ok(Event::End(e)) => {
                if e.local_name().as_ref() == b"t" {
                    in_t = false;
                }
                if p_depth == Some(depth) && e.local_name().as_ref() == b"p" {
                    p_depth = None;
                }
                depth = depth.saturating_sub(1);
            }
            Ok(Event::Text(t)) if in_t => {
                if let (Some(s), Ok(text)) = (out.last_mut(), t.decode()) {
                    s.push_str(&text);
                }
            }
            Ok(Event::GeneralRef(r)) if in_t => {
                let name: &[u8] = &r;
                let c = match name {
                    b"amp" => "&",
                    b"lt" => "<",
                    b"gt" => ">",
                    b"quot" => "\"",
                    b"apos" => "'",
                    _ => "",
                };
                if let Some(s) = out.last_mut() {
                    s.push_str(c);
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    out
}
