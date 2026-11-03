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

use docx_lower::ir::{
    LoweredBlock, LoweredCell, LoweredDoc, LoweredParagraph, LoweredStyle, LoweredTable,
    StyleCollection,
};
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
    if p.images.iter().any(|i| i.fx.is_some()) {
        Err("picture look")
    } else if !p.text_boxes.is_empty() {
        Err("text box")
    } else if !p.segments.is_empty() {
        Err("break inside a paragraph")
    } else if p.mark_change.is_some() || p.props_change.is_some() {
        Err("tracked paragraph change")
    } else {
        for r in &p.runs {
            // Notes are not placed (the stripped document has none left).
            if r.note.is_some() {
                return Err("note");
            }
            if r.change.is_some() || r.format_change.is_some() {
                return Err("tracked change");
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

/// Style properties the mutation door refuses on a style (the pour's sequential
/// lane drops them with a warning too): a character language.
const UNSETTABLE: [&str; 1] = ["characterLanguage"];

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
        for p in s
            .props
            .iter()
            .filter(|p| !UNSETTABLE.contains(&p.path.as_str()))
        {
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

/// A cell's paragraphs are text and styles alone: what the cell pour has no
/// address for (a bookmark, a link, a field, a comment, a list item, a drop
/// cap) is the pour's.
fn plain_cell(p: &LoweredParagraph) -> Result<(), &'static str> {
    plain(p)?;
    if !p.images.is_empty() {
        Err("picture")
    } else if !p.bookmarks.is_empty() {
        Err("bookmark")
    } else if p.list.is_some() {
        Err("list item")
    } else if p.drop_cap.is_some() {
        Err("drop cap")
    } else if p
        .runs
        .iter()
        .any(|r| r.hyperlink_url.is_some() || r.field.is_some() || !r.comments.is_empty())
    {
        Err("link, field or comment")
    } else {
        Ok(())
    }
}

/// Whether a table is one this builder takes: every paragraph of every cell
/// is plain, and no cell holds a picture (a later slice).
fn plain_table(t: &LoweredTable) -> Result<(), String> {
    if !t.flow.is_empty() {
        return Err("table poured as text".into());
    }
    for c in &t.cells {
        for p in &c.paragraphs {
            plain_cell(p).map_err(|why| format!("in a table cell: {why}"))?;
        }
        for n in &c.nested {
            plain_table(&n.table)?;
        }
    }
    Ok(())
}

/// The styles a table's paragraphs name: those the lowering invented are
/// kept (a cell has no model range to carry direct formatting, so the cell
/// text takes it from them, as the pour does).
fn table_styles(t: &LoweredTable, out: &mut HashSet<String>) {
    out.extend(t.para_style_id.iter().cloned());
    for c in &t.cells {
        for p in &c.paragraphs {
            out.extend(p.para_style_id.iter().cloned());
            out.extend(p.runs.iter().filter_map(|r| r.char_style_id.clone()));
        }
        for n in &c.nested {
            table_styles(&n.table, out);
        }
    }
}

fn cell_text(c: &LoweredCell) -> String {
    c.paragraphs
        .iter()
        .map(|p| p.runs.iter().map(|r| r.text.as_str()).collect::<String>())
        .collect::<Vec<_>>()
        .join("\n")
}

fn cell_addr(table: &str, c: &LoweredCell) -> Value {
    json!({ "tableId": table, "row": c.row, "col": c.col })
}

fn cell_style(
    story: &str,
    start: usize,
    end: usize,
    style: &str,
    scope: &str,
    cell: &Value,
) -> Value {
    json!({
        "op": "applyStyle",
        "args": { "storyId": story, "start": start, "end": end, "style": style,
                  "scope": scope, "cell": cell }
    })
}

fn length(v: f32) -> Value {
    json!({ "type": "length", "value": v })
}

/// The `insertTable` operation (the pour's `buildTableInsert`).
fn insert_table(t: &LoweredTable, story: &str) -> Value {
    let l = t.layout.clone().unwrap_or_default();
    let width = match (l.width_pt, l.width_pct) {
        (Some(w), _) => json!({ "unit": "points", "value": w }),
        (None, Some(p)) => json!({ "unit": "percent", "value": p }),
        _ => Value::Null,
    };
    let cell_widths: Vec<Value> = l
        .cell_widths_pt
        .iter()
        .enumerate()
        .filter_map(|(i, w)| {
            let (w, c) = (w.as_ref()?, t.cells.get(i)?);
            Some(json!({ "row": c.row, "col": c.col, "width": { "unit": "points", "value": w } }))
        })
        .collect();
    let cant_split: Vec<usize> = l
        .cant_split
        .iter()
        .enumerate()
        .filter_map(|(r, c)| c.then_some(r))
        .collect();
    json!({
        "op": "insertTable",
        "args": {
            "storyId": story, "rows": t.rows, "cols": t.cols,
            "headerRows": t.header_rows, "footerRows": 0,
            "columnWidths": t.column_widths_pt, "rowHeights": t.row_heights_pt,
            "word": {
                "indent": l.indent_pt.unwrap_or(0.0), "autofit": !l.fixed, "width": width,
                "cellWidths": cell_widths, "cantSplitRows": cant_split,
            },
        }
    })
}

/// A table's cells (the pour's `buildTableCells`): text per cell with its
/// styles, geometry, borders and fill, spans, exact row heights and the
/// tables nested in a cell.
fn table_cells(t: &LoweredTable, story: &str, table: &str, tag: &str, out: &mut Vec<Value>) {
    for (n, c) in t.cells.iter().enumerate() {
        let text = cell_text(c);
        let addr = cell_addr(table, c);
        let styled_empty = c.paragraphs.iter().any(|p| p.para_style_id.is_some());
        if text.is_empty() && styled_empty {
            out.push(json!({
                "op": "insertText",
                "args": { "storyId": story, "offset": 0, "text": "", "cell": addr }
            }));
        }
        if !text.is_empty() {
            out.push(json!({
                "op": "insertText",
                "args": { "storyId": story, "offset": 0, "text": text, "cell": addr }
            }));
            let mut at = 0usize;
            for p in &c.paragraphs {
                let from = at;
                for r in &p.runs {
                    let start = at;
                    at += r.text.chars().count();
                    if let (Some(s), true) = (&r.char_style_id, at > start) {
                        out.push(cell_style(story, start, at, s, "character", &addr));
                    }
                }
                if let (Some(s), true) = (&p.para_style_id, at > from) {
                    out.push(cell_style(story, from, at, s, "paragraph", &addr));
                }
            }
        }
        let element = json!({
            "kind": "tableCell",
            "id": { "story_id": story, "table_id": table, "row": c.row, "col": c.col }
        });
        let prop = |path: &str, value: Value| {
            json!({ "op": "setElementProperty",
                    "args": { "elementId": element, "path": path, "value": value } })
        };
        if let Some(ins) = c.insets_pt {
            for (path, pt) in [
                "cellInsetTop",
                "cellInsetLeft",
                "cellInsetBottom",
                "cellInsetRight",
            ]
            .iter()
            .zip(ins)
            {
                out.push(prop(path, length(pt)));
            }
        }
        if let Some(v) = &c.v_align {
            out.push(prop(
                "cellVerticalJustification",
                json!({ "type": "text", "value": v }),
            ));
        }
        if let Some(look) = &c.look {
            for (side, e) in [
                ("Top", &look.top),
                ("Left", &look.left),
                ("Bottom", &look.bottom),
                ("Right", &look.right),
            ] {
                out.push(prop(
                    &format!("cell{side}EdgeStrokeWeight"),
                    length(e.weight_pt),
                ));
                out.push(prop(
                    &format!("cell{side}EdgeStrokeColor"),
                    json!({ "type": "colorRef", "value": e.color }),
                ));
            }
            if let Some(f) = &look.fill {
                out.push(prop(
                    "cellFillColor",
                    json!({ "type": "colorRef", "value": f }),
                ));
            }
        }
        for (k, nested) in c.nested.iter().enumerate() {
            let handle = format!("{tag}n{n}_{k}");
            let mut insert = insert_table(&nested.table, story);
            insert["args"]["cell"] = addr.clone();
            insert["args"]["paragraph"] = json!(nested.paragraph);
            out.push(insert);
            out.push(json!({ "op": "bindCreated", "args": { "handle": handle } }));
            table_cells(&nested.table, story, &format!("$h:{handle}"), &handle, out);
        }
        if c.row_span > 1 || c.col_span > 1 {
            out.push(json!({
                "op": "setCellSpan",
                "args": { "storyId": story, "tableId": table, "row": c.row, "col": c.col,
                          "rowSpan": c.row_span, "columnSpan": c.col_span }
            }));
        }
    }
    if let Some(l) = &t.layout {
        for (row, exact) in l.exact_rows.iter().enumerate() {
            if *exact {
                out.push(json!({
                    "op": "setRowHeight",
                    "args": { "storyId": story, "tableId": table, "row": row,
                              "height": t.row_heights_pt.get(row), "autoGrow": false }
                }));
            }
        }
    }
}

/// The carets that style a table's blank cell lines, in the cell's own
/// offsets (the pour's `buildTableCellCarets`).
fn table_carets(t: &LoweredTable, story: &str, table: &str, out: &mut Vec<Value>) {
    for c in &t.cells {
        let styled_empty = c.paragraphs.iter().any(|p| p.para_style_id.is_some());
        if cell_text(c).is_empty() && !styled_empty {
            continue;
        }
        let addr = cell_addr(table, c);
        let mut last: Vec<(usize, &String)> = Vec::new();
        let mut at = 0usize;
        for p in &c.paragraphs {
            let from = at;
            for r in &p.runs {
                at += r.text.chars().count();
            }
            if let (Some(s), true) = (&p.para_style_id, at == from) {
                match last.iter_mut().find(|(o, _)| *o == from) {
                    Some(e) => e.1 = s,
                    None => last.push((from, s)),
                }
            }
        }
        for (o, s) in last {
            out.push(cell_style(story, o, o, s, "paragraph", &addr));
        }
    }
}

/// A float's anchored-object settings on the frame `handle` names.
fn anchor_sets(a: &docx_lower::ir::LoweredAnchor, handle: &str) -> Vec<Value> {
    let element = json!({ "kind": "rectangle", "id": format!("$h:{handle}") });
    let text = |v: &str| json!({ "type": "text", "value": v });
    [
        ("anchoredPosition", text(&a.position)),
        ("anchorPoint", text(&a.anchor_point)),
        ("anchoredHorizontalReference", text(&a.horizontal_reference)),
        ("anchoredHorizontalAlignment", text(&a.horizontal_alignment)),
        ("anchoredVerticalReference", text(&a.vertical_reference)),
        ("anchoredVerticalAlignment", text(&a.vertical_alignment)),
        ("anchoredXOffset", length(a.x_offset_pt)),
        ("anchoredYOffset", length(a.y_offset_pt)),
    ]
    .into_iter()
    .map(|(path, value)| {
        json!({ "op": "setElementProperty",
                "args": { "elementId": element, "path": path, "value": value } })
    })
    .collect()
}

/// An anchored frame's wrap, z-order and overlap (`layoutSpec`).
fn layout_spec(l: &docx_lower::ir::LoweredFloatLayout) -> Value {
    let wrap = l.wrap.as_ref().map_or(Value::Null, |w| {
        json!({ "mode": w.mode, "offsets": w.offsets_pt, "side": w.side, "polygon": w.polygon_pt })
    });
    json!({
        "wrap": wrap,
        "behindText": l.behind,
        "allowOverlap": if l.no_overlap { json!(false) } else { Value::Null },
        "insets": Value::Null,
        "verticalJustification": Value::Null,
    })
}

/// A picture as an anchored frame of its line: the frame, and in one batch
/// with it the float's anchored-object settings and the crop's placement.
fn picture_op(
    img: &docx_lower::ir::LoweredImage,
    story: &str,
    offset: usize,
    paragraph: usize,
    k: usize,
) -> Value {
    let mut args = json!({
        "storyId": story, "offset": offset, "width": img.width_pt, "height": img.height_pt,
        "imageUri": img.uri, "paragraph": paragraph,
    });
    if let Some(l) = &img.layout {
        args["layout"] = layout_spec(l);
    }
    let insert = json!({ "op": "insertAnchoredFrame", "args": args });
    let crop = |handle: &str| {
        img.crop.and_then(|c| c.placement).map(|t| {
            json!({ "op": "setElementProperty", "args": {
                "elementId": { "kind": "rectangle", "id": format!("$h:{handle}") },
                "path": "imageContentTransform",
                "value": { "type": "transform", "value": t } } })
        })
    };
    let (handle, mut ops) = if let Some(a) = &img.anchor {
        let h = format!("docFloat{k}");
        let sets = anchor_sets(a, &h);
        (h, sets)
    } else if img.crop.is_some_and(|c| c.placement.is_some()) {
        (format!("docxPicture{k}"), Vec::new())
    } else {
        return insert;
    };
    ops.splice(
        0..0,
        [
            insert,
            json!({ "op": "bindCreated", "args": { "handle": handle } }),
        ],
    );
    ops.extend(crop(&handle));
    json!({ "op": "batch", "args": { "ops": ops } })
}

/// The comments whose range is in the story: each thread's first comment
/// over its range, its replies after it (the pour's `buildCommentMutations`).
fn comment_ops(doc: &LoweredDoc, story: &str, ranges: &[(String, usize, usize)]) -> Vec<Value> {
    let spec = |c: &docx_lower::ir::LoweredComment| {
        let mut m = json!({ "id": c.id, "text": c.text });
        for (k, v) in [
            ("author", &c.author),
            ("initials", &c.initials),
            ("date", &c.date),
        ] {
            if let Some(v) = v {
                m[k] = json!(v);
            }
        }
        if c.resolved {
            m["resolved"] = json!(true);
        }
        m
    };
    let mut ops = Vec::new();
    for root in doc.comments.iter().filter(|c| c.parent_id.is_none()) {
        let Some((_, start, end)) = ranges.iter().find(|(id, _, _)| *id == root.id) else {
            continue;
        };
        if end <= start {
            continue;
        }
        ops.push(json!({
            "op": "insertComment",
            "args": { "storyId": story, "start": start, "end": end, "comment": spec(root) }
        }));
        for reply in doc
            .comments
            .iter()
            .filter(|c| c.parent_id.as_deref() == Some(root.id.as_str()))
        {
            ops.push(json!({
                "op": "replyComment",
                "args": { "parentId": root.id, "comment": spec(reply) }
            }));
        }
    }
    ops
}

/// One run of consecutive Word paragraphs the story takes as text.
struct Step<'a> {
    paras: Vec<&'a Paragraph>,
    lowered: Vec<&'a LoweredParagraph>,
}

/// The placement of `doc` into the story `story`, or why it is not one this
/// builder takes (the bundle then places it by the TypeScript pour).
pub fn place_batch(doc: &LoweredDoc, story: &str) -> Result<PlaceBatch, String> {
    if !doc.page_items.is_empty() {
        return Err("floating objects placed on the page".into());
    }
    let body = native_body(doc);
    if !body.extra.is_empty() {
        return Err("text boxes".into());
    }
    let mut keep: HashSet<String> = body.keep_styles.iter().cloned().collect();
    // The blocks in order: a text step per run of paragraphs, a table between.
    enum Piece<'a> {
        Text(Step<'a>),
        Table(&'a LoweredTable),
    }
    let mut pieces: Vec<Piece> = Vec::new();
    for (i, (lowered, built)) in doc.story.blocks.iter().zip(&body.blocks).enumerate() {
        match (lowered, built) {
            (LoweredBlock::Paragraph(p), NativeBlock::Paragraph(para)) => {
                plain(p).map_err(|why| format!("block {i}: {why}"))?;
                match pieces.last_mut() {
                    Some(Piece::Text(s)) => {
                        s.paras.push(para);
                        s.lowered.push(p);
                    }
                    _ => pieces.push(Piece::Text(Step {
                        paras: vec![para],
                        lowered: vec![p],
                    })),
                }
            }
            (LoweredBlock::Table(t), NativeBlock::Table(_)) => {
                plain_table(t).map_err(|why| format!("block {i}: {why}"))?;
                table_styles(t, &mut keep);
                pieces.push(Piece::Table(t));
            }
            (_, NativeBlock::Deferred { reason }) => {
                return Err(format!("block {i}: {reason}"));
            }
            _ => return Err(format!("block {i}: not a plain paragraph or table")),
        }
    }
    // The invented styles a kept one is based on.
    let by_id: std::collections::HashMap<&str, &LoweredStyle> =
        doc.styles.iter().map(|s| (s.id.as_str(), s)).collect();
    let mut closure: Vec<String> = keep.iter().cloned().collect();
    while let Some(id) = closure.pop() {
        if let Some(parent) = by_id.get(id.as_str()).and_then(|s| s.based_on.clone()) {
            if is_synthesized(&parent) && keep.insert(parent.clone()) {
                closure.push(parent);
            }
        }
    }

    let mut body_ops: Vec<Value> = Vec::new();
    let mut carets: Vec<Value> = Vec::new();
    let mut cell_carets: Vec<Value> = Vec::new();
    // `at`: the contiguous character offsets (style ranges); `text_at`: the
    // `insertText` space (bytes and the paragraph breaks); `last`: the index
    // of the story's last paragraph, -1 while the story is fresh.
    let mut at = 0usize;
    let mut text_at = 0usize;
    let mut last: isize = -1;
    let mut ends_in_table = false;
    let mut ends_in_empty = false;
    let mut tables = 0usize;
    let mut pictures = 0usize;
    // Each comment's range over the poured text, in order of appearance.
    let mut comment_ranges: Vec<(String, usize, usize)> = Vec::new();
    for piece in &pieces {
        match piece {
            Piece::Text(step) => {
                let lead = ends_in_table;
                let para_base = (last + 1) as usize;
                let mut text = String::new();
                if lead {
                    text.push('\n');
                }
                // Bytes of the finished pour beyond `text`: a field's result
                // is written by `insertField`, not by the text.
                let mut extra = 0usize;
                let mut field_ops = Vec::new();
                let mut para_ops = Vec::new();
                let mut char_ops = Vec::new();
                let mut prop_ops = Vec::new();
                let mut image_ops = Vec::new();
                let mut link_ops = Vec::new();
                let mut anchor_ops = Vec::new();
                for (i, para) in step.paras.iter().enumerate() {
                    if i > 0 {
                        text.push('\n');
                    }
                    let start = at;
                    for name in &step.lowered[i].bookmarks {
                        if name != "_GoBack" {
                            anchor_ops.push(json!({
                                "op": "insertTextAnchor",
                                "args": { "storyId": story, "offset": start,
                                          "contentOffset": text_at + text.len() + extra,
                                          "name": name }
                            }));
                        }
                    }
                    for img in &step.lowered[i].images {
                        image_ops.push(picture_op(
                            img,
                            story,
                            start + img.at as usize,
                            para_base + i,
                            pictures,
                        ));
                        pictures += 1;
                    }
                    let mut runs: Vec<(usize, usize, &paged_model::CharacterRun)> = Vec::new();
                    for r in para.runs.iter().filter(|r| !r.text.is_empty()) {
                        let n = r.text.chars().count();
                        if let Some(f) = &r.field {
                            field_ops.push(json!({
                                "op": "insertField",
                                "args": { "storyId": story, "offset": at,
                                          "contentOffset": text_at + text.len() + extra,
                                          "field": { "word": { "code": f.code, "result": r.text } } }
                            }));
                            extra += r.text.len();
                        } else {
                            text.push_str(&r.text);
                        }
                        if let Some(src) = &r.hyperlink_source {
                            if let Some(l) = body.links.iter().find(|l| &l.source_id == src) {
                                link_ops.push(json!({
                                    "op": "insertHyperlink",
                                    "args": { "storyId": story, "start": at, "end": at + n,
                                              "url": l.url }
                                }));
                            }
                        }
                        for id in &r.comments {
                            match comment_ranges.iter_mut().find(|(c, _, _)| c == id) {
                                Some(c) => c.2 = at + n,
                                None => comment_ranges.push((id.clone(), at, at + n)),
                            }
                        }
                        runs.push((at, at + n, r));
                        at += n;
                    }
                    let paragraph_props = read_paragraph_props(para);
                    if runs.is_empty() {
                        // A blank line has no range to hold direct formatting.
                        if !paragraph_props.is_empty() {
                            return Err(format!(
                                "paragraph {i}: direct formatting on an empty paragraph"
                            ));
                        }
                        if let Some(s) = &para.paragraph_style {
                            carets.push(apply_style(
                                story,
                                start,
                                start,
                                s,
                                "paragraph",
                                Some(para_base + i),
                            ));
                        }
                        continue;
                    }
                    if let Some(s) = &para.paragraph_style {
                        para_ops.push(apply_style(story, start, at, s, "paragraph", None));
                    }
                    for (path, value) in &paragraph_props {
                        prop_ops.push(set(story, start, at, path, value));
                    }
                    // Word's drop cap, on the paragraph's first character.
                    if step.lowered[i].drop_cap.is_some() {
                        for (path, n) in [
                            ("paragraphDropCapCharacters", para.drop_cap_characters),
                            ("paragraphDropCapLines", para.drop_cap_lines),
                        ] {
                            prop_ops.push(set(
                                story,
                                start,
                                at.max(start + 1),
                                path,
                                &length(n as f32),
                            ));
                        }
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
                if !text.is_empty() {
                    body_ops.push(json!({
                        "op": "insertText",
                        "args": { "storyId": story, "offset": text_at, "text": text, "cell": null }
                    }));
                }
                text_at += text.len() + extra;
                body_ops.extend(field_ops);
                body_ops.extend(para_ops);
                body_ops.extend(char_ops);
                body_ops.extend(prop_ops);
                body_ops.extend(image_ops);
                body_ops.extend(link_ops);
                body_ops.extend(anchor_ops);
                last = para_base as isize + step.paras.len() as isize - 1;
                ends_in_table = false;
                ends_in_empty = step.lowered.last().is_some_and(|p| {
                    p.images.is_empty() && p.runs.iter().all(|r| r.text.is_empty())
                });
            }
            Piece::Table(t) => {
                let fresh = last < 0;
                if !fresh && ends_in_empty {
                    body_ops.push(json!({
                        "op": "insertText",
                        "args": { "storyId": story, "offset": text_at, "text": "\n", "cell": null }
                    }));
                }
                last += 1;
                ends_in_table = true;
                ends_in_empty = false;
                let handle = format!("docTable{tables}");
                tables += 1;
                body_ops.push(insert_table(t, story));
                body_ops.push(json!({ "op": "bindCreated", "args": { "handle": handle } }));
                let id = format!("$h:{handle}");
                table_cells(t, story, &id, &handle, &mut body_ops);
                table_carets(t, story, &id, &mut cell_carets);
                if let Some(s) = &t.para_style_id {
                    body_ops.push(apply_style(
                        story,
                        at,
                        at,
                        s,
                        "paragraph",
                        Some(last as usize),
                    ));
                }
                if !fresh {
                    text_at += 1;
                }
            }
        }
    }
    body_ops.extend(carets);
    body_ops.extend(cell_carets);
    body_ops.extend(comment_ops(doc, story, &comment_ranges));
    Ok(PlaceBatch {
        style_ops: style_ops(doc, &keep),
        body_ops,
    })
}
