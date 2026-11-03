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

//! Doc ADR 625 amendment, option (a): embedded placement as a batch of the
//! engine's EXISTING operations, built in Rust.
//!
//! Placement (ADR 603) adds a Word document to a live host document that has
//! its own styles, swatches and stories, so it can only go through the host's
//! mutation door. The bundle used to turn the IR into that batch in TypeScript
//! (`mutations.ts`, the pour). [`place_batch`] builds the same placement from
//! the model the standalone open builds (`body::native_body`): the text goes in
//! with `insertText`, a paragraph's and a run's named styles with `applyStyle`,
//! and their direct formatting with `setElementProperty` over the paragraph's
//! or the run's range (what the native builder sets on the model's fields), so
//! the host document holds the Word styles and no invented `docx-auto-*` ones.
//!
//! No contract change and no engine crate: the result is JSON of operations
//! the mutation door accepts today, and the bundle submits it as one batch (one
//! undo step). A document with anything this builder does not yet take is
//! refused with the reason, and the bundle places it by the TypeScript pour
//! (nothing is dropped, nothing is half-placed): the slices are paragraphs and
//! styles first; tables, pictures, fields, lists, hyperlinks, notes and
//! comments follow.

use std::collections::HashSet;

use docx_lower::ir::{LoweredBlock, LoweredDoc, LoweredParagraph, LoweredStyle, StyleCollection};
use paged_model::Paragraph;
use serde_json::{json, Value};

use crate::body::{is_synthesized, native_body, read_paragraph_props, read_run_props, NativeBlock};

/// A finished placement.
#[derive(Debug, Clone, Default)]
pub struct PlaceBatch {
    /// The swatches, colour groups and styles to create (the bundle drops
    /// those the document already has).
    pub style_ops: Vec<Value>,
    /// The story's content, addressed at the story id given to
    /// [`place_batch`] (a batch handle on a frame just made).
    pub body_ops: Vec<Value>,
}

/// Why the block is not one this builder takes yet, if it is not.
fn plain(p: &LoweredParagraph) -> Result<(), &'static str> {
    if !p.images.is_empty() {
        Err("picture")
    } else if !p.text_boxes.is_empty() {
        Err("text box")
    } else if !p.segments.is_empty() {
        Err("break inside a paragraph")
    } else if !p.bookmarks.is_empty() {
        Err("bookmark")
    } else if p.list.is_some() {
        Err("list item")
    } else if p.mark_change.is_some() || p.props_change.is_some() {
        Err("tracked paragraph change")
    } else if p.drop_cap.is_some() {
        Err("drop cap")
    } else {
        for r in &p.runs {
            if r.hyperlink_url.is_some() {
                return Err("hyperlink");
            }
            if r.field.is_some() {
                return Err("field");
            }
            if r.note.is_some() {
                return Err("note");
            }
            if r.change.is_some() || r.format_change.is_some() {
                return Err("tracked change");
            }
            if !r.comments.is_empty() {
                return Err("comment");
            }
            if r.control.is_some() {
                return Err("content control");
            }
        }
        Ok(())
    }
}

fn range(story: &str, start: usize, end: usize) -> Value {
    json!({ "kind": "storyRange", "id": { "story_id": story, "start": start, "end": end } })
}

fn set(story: &str, start: usize, end: usize, path: &str, value: &impl serde::Serialize) -> Value {
    json!({
        "op": "setElementProperty",
        "args": {
            "elementId": range(story, start, end),
            "path": path,
            "value": value,
        }
    })
}

fn apply_style(
    story: &str,
    start: usize,
    end: usize,
    style: &str,
    scope: &str,
    paragraph: Option<usize>,
) -> Value {
    let mut args = json!({
        "storyId": story, "start": start, "end": end, "style": style, "scope": scope,
    });
    if let Some(i) = paragraph {
        args["paragraph"] = json!(i);
    }
    json!({ "op": "applyStyle", "args": args })
}

/// The swatches, colour groups and styles of a placement, as the engine's
/// `createSwatch` / `createColorGroup` / `create*Style` / `setStyleProperty`
/// (what `buildStyleMutations` sends for a placement: no theme). The styles
/// the lowering invented for direct formatting are left out but for those a
/// native paragraph keeps (`keep`): the document then holds only the styles
/// Word defined.
pub fn style_ops(doc: &LoweredDoc, keep: &HashSet<String>) -> Vec<Value> {
    let mut ops = Vec::new();
    for sw in &doc.swatches {
        ops.push(json!({
            "op": "createSwatch",
            "args": { "spec": {
                "selfId": sw.id, "name": sw.name, "space": sw.space, "value": sw.value,
            } }
        }));
    }
    for g in &doc.color_groups {
        ops.push(json!({
            "op": "createColorGroup",
            "args": { "spec": { "selfId": g.id, "name": g.name, "members": g.members } }
        }));
    }
    let wanted = |s: &&LoweredStyle| !is_synthesized(&s.id) || keep.contains(&s.id);
    for s in doc.styles.iter().filter(wanted) {
        let op = match s.collection {
            StyleCollection::Paragraph => "createParagraphStyle",
            StyleCollection::Character => "createCharacterStyle",
        };
        ops.push(json!({
            "op": op,
            "args": { "selfId": s.id, "name": s.name, "basedOn": s.based_on }
        }));
        for p in &s.props {
            ops.push(json!({
                "op": "setStyleProperty",
                "args": {
                    "collection": match s.collection {
                        StyleCollection::Paragraph => "paragraph",
                        StyleCollection::Character => "character",
                    },
                    "styleId": s.id, "path": p.path, "value": p.value,
                }
            }));
        }
    }
    ops
}

/// The placement of `doc` into the story `story`, or why it is not one this
/// builder takes (the bundle then places it by the TypeScript pour).
pub fn place_batch(doc: &LoweredDoc, story: &str) -> Result<PlaceBatch, String> {
    if !doc.page_items.is_empty() {
        return Err("floating objects placed on the page".into());
    }
    let body = native_body(doc);
    if !body.links.is_empty() || !body.extra.is_empty() {
        return Err("hyperlinks or text boxes".into());
    }
    let mut paras: Vec<&Paragraph> = Vec::new();
    for (i, (lowered, built)) in doc.story.blocks.iter().zip(&body.blocks).enumerate() {
        let LoweredBlock::Paragraph(p) = lowered else {
            return Err("table".into());
        };
        plain(p).map_err(|why| format!("block {i}: {why}"))?;
        match built {
            NativeBlock::Paragraph(para) => paras.push(para),
            NativeBlock::Deferred { reason } => return Err(format!("block {i}: {reason}")),
            _ => return Err(format!("block {i}: not a plain paragraph")),
        }
    }
    let mut text = String::new();
    let mut para_ops = Vec::new();
    let mut char_ops = Vec::new();
    let mut prop_ops = Vec::new();
    let mut carets = Vec::new();
    let mut at = 0usize;
    for (i, para) in paras.iter().enumerate() {
        if i > 0 {
            // The paragraph break: it separates the text but does not
            // advance the contiguous offsets (the engine consumes it on the
            // split).
            text.push('\n');
        }
        let start = at;
        let mut runs: Vec<(usize, usize, &paged_model::CharacterRun)> = Vec::new();
        for r in para.runs.iter().filter(|r| !r.text.is_empty()) {
            let n = r.text.chars().count();
            text.push_str(&r.text);
            runs.push((at, at + n, r));
            at += n;
        }
        let paragraph_props = read_paragraph_props(para);
        if runs.is_empty() {
            // A blank line has no range to hold direct formatting.
            if !paragraph_props.is_empty() {
                return Err(format!(
                    "block {i}: direct formatting on an empty paragraph"
                ));
            }
            if let Some(s) = &para.paragraph_style {
                carets.push(apply_style(story, start, start, s, "paragraph", Some(i)));
            }
            continue;
        }
        if let Some(s) = &para.paragraph_style {
            para_ops.push(apply_style(story, start, at, s, "paragraph", None));
        }
        for (path, value) in &paragraph_props {
            prop_ops.push(set(story, start, at, path, value));
        }
        for (s, e, r) in runs {
            if let Some(c) = &r.character_style {
                char_ops.push(apply_style(story, s, e, c, "character", None));
            }
            for (path, value) in &read_run_props(r) {
                prop_ops.push(set(story, s, e, path, value));
            }
        }
    }
    let mut body_ops = Vec::new();
    if !text.is_empty() {
        body_ops.push(json!({
            "op": "insertText",
            "args": { "storyId": story, "offset": 0, "text": text, "cell": null }
        }));
    }
    body_ops.extend(para_ops);
    body_ops.extend(char_ops);
    body_ops.extend(prop_ops);
    body_ops.extend(carets);
    Ok(PlaceBatch {
        style_ops: style_ops(doc, &body.keep_styles.iter().cloned().collect()),
        body_ops,
    })
}
