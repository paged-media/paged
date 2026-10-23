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

//! Row/column inserts and deletes across the preserved content (W1.2).
//!
//! What the engine does not model still addresses cells: conditional
//! formats, validations, hyperlinks, filters and sorts, page breaks, sheet
//! views, sparklines, tables, drawings and pictures, notes and threaded
//! comments, defined names and print areas, chart series. A structural edit
//! moves every one of them the way it moves a formula (the parser's text
//! shift, `sheet_parser::shift_ref_text` / `shift_sqref`): a range grows
//! when the edit inserts inside it, clips when it deletes part of it, and
//! the thing it belongs to goes when the edit deletes all of it (a
//! conditional format, a validation, a hyperlink, a note — as in Excel).
//! Shifting is preservation, not interpretation: a validation's formula is
//! moved as text and still never evaluated.
//!
//! Only the bytes that change are rewritten (start tags re-rendered, leaf
//! texts replaced, dropped elements cut); everything else stays as read.
//! The edit is planned whole first and applied only when nothing refuses:
//! content that cannot be shifted is named and the edit is refused with the
//! package untouched. What still refuses: a pivot table on the sheet or a
//! pivot cache over it (ADR 504), an extension (`extLst`) Paged does not
//! know that holds cell references, a reference over a span of sheets
//! that holds the edited sheet (`Jan:Mar!A1`), and an unterminated string.
//! A table the edit deletes whole goes, with its part and relationship.

use std::collections::BTreeSet;

use sheet_core::SheetId;
use sheet_parser::{shift_index, shift_ref_text, shift_sqref, Edit, TextShift, Unshiftable};

use crate::rels::{parse_rels, part_dir, rels_part_name, resolve_target};
use crate::splice::{attr_local, attrs_of, children_of, render_tag, root_children, set_attr, Span};
use crate::XlsxDocument;

/// The extension URIs of the worksheet `extLst` whose content Paged knows
/// (and shifts): x14 conditional formats, x14 data validations, sparklines,
/// x14 protected ranges, and the slicer / timeline / web-extension lists
/// (which hold no cell references).
const KNOWN_EXT: &[&str] = &[
    "{78C0D931-6437-407d-A8EE-F0AAD7539E65}",
    "{CCE6A557-97BC-4b89-ADB6-D9C93CAAB3DF}",
    "{05C60535-1F16-4fd2-B633-F4F36F0B64E0}",
    "{FC87AEE6-9EDD-4A0A-B7FB-166176984837}",
    "{A8765BA9-456A-4dab-B4F3-ACF838C121DE}",
    "{3A4CF648-6AED-40f4-86FF-DC5316D8AED3}",
    "{7E03D99C-DC04-49d9-9315-930204A7B6E9}",
    "{F7C9EE02-42E1-4005-9D12-6889AFFD525C}",
];

/// Elements whose `ref` is a range (list) that goes with its owner.
const REF_OWNERS: &[&str] = &[
    "hyperlink",
    "autoFilter",
    "sortState",
    "sortCondition",
    "table",
    "comment",
    "threadedComment",
    "dataRef",
    "customSheetView",
];

/// Leaf elements whose text is a formula.
const FORMULA_TEXT: &[&str] = &[
    "formula",
    "formula1",
    "formula2",
    "f",
    "calculatedColumnFormula",
    "totalsRowFormula",
];

/// Containers that must hold at least one child: they go when the edit
/// removes every one.
const NON_EMPTY: &[&str] = &[
    "conditionalFormatting",
    "conditionalFormattings",
    "dataValidations",
    "hyperlinks",
    "rowBreaks",
    "colBreaks",
    "ignoredErrors",
    "protectedRanges",
    "cellWatches",
    "sparklines",
    "sparklineGroups",
    "ext",
    "extLst",
];

/// Children whose loss takes the parent with them.
const REQUIRED_CHILD: &[&str] = &["sqref", "sparklines"];

/// One piece of preserved content as seen by the shift.
#[derive(Clone, Copy)]
struct Ctx<'a> {
    ts: TextShift<'a>,
    /// Refuse unknown extensions holding references (worksheet content);
    /// a chart's own extensions are walked like the rest of the chart.
    strict_ext: bool,
}

impl Ctx<'_> {
    fn text(&self, t: &str) -> Result<String, Unshiftable> {
        shift_ref_text(t, &self.ts)
    }
    fn sqref(&self, t: &str) -> Result<Option<String>, Unshiftable> {
        shift_sqref(t, &self.ts)
    }
    fn rows(&self) -> bool {
        sheet_parser::edit_is_rows(&self.ts.edit)
    }
    /// A single cell that must stay somewhere (a view's active cell): a
    /// deleted one lands on the first row/column after the deleted span.
    fn clamped_cell(&self, v: &str) -> Result<String, Unshiftable> {
        if let Some(s) = self.sqref(v)? {
            return Ok(s);
        }
        let Some((r, c, ra, ca)) = sheet_core::parse_a1(v) else {
            return Ok(v.to_string());
        };
        let at = match self.ts.edit {
            Edit::InsertRows { at, .. }
            | Edit::DeleteRows { at, .. }
            | Edit::InsertCols { at, .. }
            | Edit::DeleteCols { at, .. } => at,
        };
        let (r, c) = if self.rows() {
            (at.min(sheet_core::MAX_ROW), c)
        } else {
            (r, at.min(sheet_core::MAX_COL))
        };
        Ok(sheet_core::format_a1(r, c, ra, ca).to_string())
    }
}

/// What the walk made of one element.
enum Out {
    Same,
    Drop,
    New(String),
}

fn xml_err(e: crate::XlsxError) -> Unshiftable {
    Unshiftable(format!("not readable XML: {e}"))
}

fn local_of(k: &str) -> &str {
    k.rsplit(':').next().unwrap_or(k)
}

/// Whether raw XML holds something that reads as a cell reference.
fn has_refs(raw: &[u8]) -> bool {
    let s = String::from_utf8_lossy(raw);
    s.contains("sqref") || s.contains(":f>") || s.contains("<f>") || s.contains(" ref=\"")
}

/// The unescaped text of a leaf element.
fn leaf_text(xml: &[u8], span: &Span) -> String {
    let close = format!("</{}>", span.qname);
    let end = span.end.saturating_sub(close.len()).max(span.tag_end);
    // XML end-of-line handling: a literal CR LF (or lone CR) reads as LF,
    // as the reader that produced the model's text reads it.
    let raw = String::from_utf8_lossy(&xml[span.tag_end..end])
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    quick_xml::escape::unescape(&raw)
        .map(|c| c.into_owned())
        .unwrap_or_else(|_| raw.clone())
}

/// Walk one element (post-order) and shift what it addresses.
fn walk(xml: &[u8], span: &Span, parent: &str, cx: &Ctx<'_>) -> Result<Out, Unshiftable> {
    let local = span.local.as_str();
    let attrs = attrs_of(xml, span).map_err(xml_err)?;
    if local == "ext" && cx.strict_ext {
        let uri = attr_local(&attrs, "uri").unwrap_or_default();
        if !KNOWN_EXT.contains(&uri.as_str()) {
            if has_refs(&xml[span.start..span.end]) {
                return Err(Unshiftable(format!(
                    "an extension Paged does not know ({uri}) holds cell references"
                )));
            }
            return Ok(Out::Same);
        }
    }

    // Attributes.
    let mut a = attrs.clone();
    for (k, v) in &attrs {
        let key = local_of(k);
        let new: Option<String> = match (key, local) {
            ("sqref", "selection") => Some(match cx.sqref(v)? {
                Some(s) => s,
                None => {
                    let active = attr_local(&attrs, "activeCell").unwrap_or_else(|| "A1".into());
                    cx.clamped_cell(&active)?
                }
            }),
            ("sqref", _) => match cx.sqref(v)? {
                Some(s) => Some(s),
                None => return Ok(Out::Drop),
            },
            ("ref", owner) if REF_OWNERS.contains(&owner) => match cx.sqref(v)? {
                Some(s) => Some(s),
                None => return Ok(Out::Drop),
            },
            ("activeCell" | "topLeftCell", _) => Some(cx.clamped_cell(v)?),
            ("val", "cfvo") | ("textlink", _) => Some(cx.text(v)?),
            // A hyperlink's in-workbook target is navigation: shifted when it
            // reads, kept when it does not.
            ("location", "hyperlink") => Some(cx.text(v).unwrap_or_else(|_| v.clone())),
            ("r", "inputCells") => match cx.sqref(v)? {
                Some(s) => Some(s),
                None => {
                    return Err(Unshiftable(format!(
                        "a scenario's input cell {v} would be deleted"
                    )))
                }
            },
            ("r", "cellWatch") => match cx.sqref(v)? {
                Some(s) => Some(s),
                None => return Ok(Out::Drop),
            },
            ("id", "brk") if cx.ts.host_is_target => {
                let on_axis = (parent == "rowBreaks") == cx.rows();
                match v.trim().parse::<u32>() {
                    Ok(i) if on_axis => match shift_index(&cx.ts.edit, i) {
                        Some(n) => Some(n.to_string()),
                        None => return Ok(Out::Drop),
                    },
                    _ => None,
                }
            }
            _ => None,
        };
        if let Some(n) = new {
            if &n != v {
                set_attr(&mut a, key, Some(n));
            }
        }
    }

    if span.empty {
        return Ok(if a == attrs {
            Out::Same
        } else {
            Out::New(render_tag(&span.qname, &a, true))
        });
    }
    let (kids, close) = children_of(xml, span).map_err(xml_err)?;
    if kids.is_empty() {
        let text = leaf_text(xml, span);
        let new_text = if FORMULA_TEXT.contains(&local) {
            let t = cx.text(&text)?;
            (t != text).then_some(t)
        } else if local == "sqref" {
            match cx.sqref(&text)? {
                None => return Ok(Out::Drop),
                Some(t) => (t != text).then_some(t),
            }
        } else {
            None
        };
        if new_text.is_none() && a == attrs {
            return Ok(Out::Same);
        }
        let mut s = render_tag(&span.qname, &a, false);
        match new_text {
            Some(t) => s.push_str(&paged_ooxml::xml::escape_text(&t)),
            None => s.push_str(&String::from_utf8_lossy(&xml[span.tag_end..close])),
        }
        s.push_str(&String::from_utf8_lossy(&xml[close..span.end]));
        return Ok(Out::New(s));
    }

    // The autoFilter's column criteria are offsets into its range.
    let af_cols = if local == "autoFilter" && !cx.rows() && cx.ts.host_is_target {
        let old = attr_local(&attrs, "ref")
            .as_deref()
            .and_then(crate::parts::worksheet::parse_range)
            .map(|r| r.normalized().start.col);
        let new = attr_local(&a, "ref")
            .as_deref()
            .and_then(crate::parts::worksheet::parse_range)
            .map(|r| r.normalized().start.col);
        old.zip(new)
    } else {
        None
    };

    let mut body = String::new();
    let mut pos = span.tag_end;
    let mut changed = a != attrs;
    let mut kept = 0usize;
    let mut dropped: Vec<&str> = Vec::new();
    for k in &kids {
        body.push_str(&String::from_utf8_lossy(&xml[pos..k.start]));
        pos = k.end;
        let mut out = walk(xml, k, local, cx)?;
        if let (Some((old0, new0)), "filterColumn") = (af_cols, k.local.as_str()) {
            let ka = attrs_of(xml, k).map_err(xml_err)?;
            if let Some(id) = attr_local(&ka, "colId").and_then(|v| v.parse::<u32>().ok()) {
                out = match shift_index(&cx.ts.edit, old0 + id) {
                    None => Out::Drop,
                    Some(c) if c.checked_sub(new0) == Some(id) => out,
                    Some(c) => {
                        let mut ka = ka.clone();
                        set_attr(&mut ka, "colId", Some(c.saturating_sub(new0).to_string()));
                        let raw = match out {
                            Out::New(s) => s.into_bytes(),
                            _ => xml[k.start..k.end].to_vec(),
                        };
                        let tag_len = k.tag_end - k.start;
                        let mut s = render_tag(&k.qname, &ka, k.empty);
                        s.push_str(&String::from_utf8_lossy(&raw[tag_len.min(raw.len())..]));
                        Out::New(s)
                    }
                };
            }
        }
        match out {
            Out::Same => {
                kept += 1;
                body.push_str(&String::from_utf8_lossy(&xml[k.start..k.end]));
            }
            Out::New(s) => {
                kept += 1;
                changed = true;
                body.push_str(&s);
            }
            Out::Drop => {
                changed = true;
                dropped.push(k.local.as_str());
            }
        }
    }
    body.push_str(&String::from_utf8_lossy(&xml[pos..close]));
    if dropped.iter().any(|d| REQUIRED_CHILD.contains(d)) {
        return Ok(Out::Drop);
    }
    if !dropped.is_empty() {
        if kept == 0 && NON_EMPTY.contains(&local) {
            return Ok(Out::Drop);
        }
        for key in ["count", "manualBreakCount"] {
            if attr_local(&a, key).is_some() {
                set_attr(&mut a, key, Some(kept.to_string()));
            }
        }
    }
    if !changed {
        return Ok(Out::Same);
    }
    let mut s = render_tag(&span.qname, &a, false);
    s.push_str(&body);
    s.push_str(&String::from_utf8_lossy(&xml[close..span.end]));
    Ok(Out::New(s))
}

/// Shift a whole element's bytes (`None`: the edit removes it).
fn shift_element(bytes: &[u8], cx: &Ctx<'_>) -> Result<Option<Vec<u8>>, Unshiftable> {
    let span = root_span(bytes)?;
    Ok(match walk(bytes, &span, "", cx)? {
        Out::Same => Some(bytes.to_vec()),
        Out::Drop => None,
        Out::New(s) => {
            let mut out = bytes[..span.start].to_vec();
            out.extend_from_slice(s.as_bytes());
            out.extend_from_slice(&bytes[span.end..]);
            Some(out)
        }
    })
}

/// The span of a document's (or fragment's) root element.
fn root_span(bytes: &[u8]) -> Result<Span, Unshiftable> {
    use quick_xml::events::Event;
    let mut reader = quick_xml::Reader::from_reader(bytes);
    let mut buf = Vec::new();
    let mut depth = 0usize;
    let mut start: Option<(usize, usize, String, String)> = None;
    loop {
        let before = reader.buffer_position() as usize;
        let ev = reader
            .read_event_into(&mut buf)
            .map_err(|e| Unshiftable(format!("not readable XML: {e}")))?;
        let after = reader.buffer_position() as usize;
        match ev {
            Event::Start(e) => {
                if depth == 0 {
                    start = Some((
                        before,
                        after,
                        String::from_utf8_lossy(e.local_name().as_ref()).into_owned(),
                        String::from_utf8_lossy(e.name().as_ref()).into_owned(),
                    ));
                }
                depth += 1;
            }
            Event::Empty(e) if depth == 0 => {
                return Ok(Span {
                    local: String::from_utf8_lossy(e.local_name().as_ref()).into_owned(),
                    qname: String::from_utf8_lossy(e.name().as_ref()).into_owned(),
                    start: before,
                    tag_end: after,
                    end: after,
                    empty: true,
                })
            }
            Event::End(_) => {
                depth -= 1;
                if depth == 0 {
                    let (s, t, local, qname) = start.take().expect("opened");
                    return Ok(Span {
                        local,
                        qname,
                        start: s,
                        tag_end: t,
                        end: after,
                        empty: false,
                    });
                }
            }
            Event::Eof => return Err(Unshiftable("no root element".into())),
            _ => {}
        }
        buf.clear();
    }
}

/// A table part shifted: its ranges and formulas, plus the columns a column
/// insert inside it adds (`ColumnN`, as Excel names them) or a delete
/// removes.
fn shift_table_part(
    bytes: &[u8],
    sheet: SheetId,
    cx: &Ctx<'_>,
) -> Result<Option<Vec<u8>>, Unshiftable> {
    let table = crate::parts::tables::parse(bytes, sheet).map_err(xml_err)?;
    // A table the edit deletes whole goes with its cells (as in Excel).
    let Some(shifted) = shift_element(bytes, cx)? else {
        return Ok(None);
    };
    if !cx.ts.host_is_target {
        return Ok(Some(shifted));
    }
    let mut edit = cx.ts.edit;
    // The table's own sheet id is the edit's.
    match &mut edit {
        Edit::InsertRows { sheet: s, .. }
        | Edit::DeleteRows { sheet: s, .. }
        | Edit::InsertCols { sheet: s, .. }
        | Edit::DeleteCols { sheet: s, .. } => *s = sheet,
    }
    let ts = sheet_parser::shift_table(table.range, &table.columns, &edit);
    if ts.inserted.is_empty() && ts.removed.is_empty() {
        return Ok(Some(shifted));
    }
    let (kids, _) = root_children(&shifted).map_err(xml_err)?;
    let Some(tc) = kids.iter().find(|k| k.local == "tableColumns") else {
        return Ok(Some(shifted));
    };
    let (cols, close) = children_of(&shifted, tc).map_err(xml_err)?;
    let mut items: Vec<String> = cols
        .iter()
        .map(|c| String::from_utf8_lossy(&shifted[c.start..c.end]).into_owned())
        .collect();
    for off in ts.removed.iter().rev() {
        if (*off as usize) < items.len() {
            items.remove(*off as usize);
        }
    }
    let first_id = cols
        .iter()
        .filter_map(|c| {
            attrs_of(&shifted, c)
                .ok()
                .and_then(|a| attr_local(&a, "id"))
                .and_then(|v| v.parse::<u32>().ok())
        })
        .max()
        .unwrap_or(0)
        + 1;
    let prefix = crate::splice::prefix_of(&tc.qname).to_string();
    for (k, (off, name)) in ts.inserted.iter().enumerate() {
        let next_id = first_id + k as u32;
        let i = (*off as usize).min(items.len());
        items.insert(
            i,
            render_tag(
                &format!("{prefix}tableColumn"),
                &[
                    ("id".to_string(), next_id.to_string()),
                    ("name".to_string(), name.to_string()),
                ],
                true,
            ),
        );
    }
    let mut a = attrs_of(&shifted, tc).map_err(xml_err)?;
    set_attr(&mut a, "count", Some(items.len().to_string()));
    let mut s = render_tag(&tc.qname, &a, false);
    s.push_str(&items.concat());
    s.push_str(&String::from_utf8_lossy(&shifted[close..tc.end]));
    Ok(Some(crate::splice::splice(
        &shifted,
        tc.start,
        tc.end,
        s.as_bytes(),
    )))
}

/// A drawing part shifted: each anchor's `from`/`to` cell moves with the
/// edit by its `editAs` (move and size, move only, or absolute).
fn shift_drawing(bytes: &[u8], cx: &Ctx<'_>) -> Result<Vec<u8>, Unshiftable> {
    let (anchors, _) = root_children(bytes).map_err(xml_err)?;
    let rows = cx.rows();
    let axis = if rows { "row" } else { "col" };
    let at = match cx.ts.edit {
        Edit::InsertRows { at, .. }
        | Edit::DeleteRows { at, .. }
        | Edit::InsertCols { at, .. }
        | Edit::DeleteCols { at, .. } => at,
    };
    let mut edits: Vec<(usize, usize, String)> = Vec::new();
    for an in &anchors {
        let a = attrs_of(bytes, an).map_err(xml_err)?;
        let edit_as = match an.local.as_str() {
            "twoCellAnchor" => attr_local(&a, "editAs").unwrap_or_else(|| "twoCell".into()),
            "oneCellAnchor" => "oneCell".into(),
            _ => continue,
        };
        if edit_as == "absolute" {
            continue;
        }
        let (kids, _) = children_of(bytes, an).map_err(xml_err)?;
        // (index span, offset span, value) of `from` and `to` on the axis.
        let mut ends: Vec<(Span, Option<Span>, u32)> = Vec::new();
        for k in kids.iter().filter(|k| k.local == "from" || k.local == "to") {
            let (parts, _) = children_of(bytes, k).map_err(xml_err)?;
            let idx = parts.iter().find(|p| p.local == axis);
            let off = parts.iter().find(|p| p.local == format!("{axis}Off"));
            if let Some(idx) = idx {
                if let Ok(v) = leaf_text(bytes, idx).trim().parse::<u32>() {
                    ends.push((idx.clone(), off.cloned(), v));
                }
            }
        }
        let Some(from) = ends.first().cloned() else {
            continue;
        };
        let moved = |v: u32| shift_index(&cx.ts.edit, v);
        let new_from = moved(from.2);
        let put = |edits: &mut Vec<(usize, usize, String)>, s: &Span, v: u32| {
            edits.push((
                s.tag_end,
                s.end - format!("</{}>", s.qname).len(),
                v.to_string(),
            ));
        };
        let from_v = new_from.unwrap_or(at);
        if from_v != from.2 {
            put(&mut edits, &from.0, from_v);
        }
        if new_from.is_none() {
            if let Some(off) = &from.1 {
                put(&mut edits, off, 0);
            }
        }
        if let Some(to) = ends.get(1) {
            let to_v = if edit_as == "twoCell" {
                moved(to.2).unwrap_or(at)
            } else {
                // Move but do not size: the far corner keeps its distance.
                (to.2 as i64 + from_v as i64 - from.2 as i64).max(0) as u32
            };
            if to_v != to.2 {
                put(&mut edits, &to.0, to_v);
            }
            if edit_as == "twoCell" && moved(to.2).is_none() {
                if let Some(off) = &to.1 {
                    put(&mut edits, off, 0);
                }
            }
        }
    }
    // Shape text links (`textlink="$A$1"`) are formulas.
    let mut out = bytes.to_vec();
    edits.sort_by_key(|e| e.0);
    for (s, e, v) in edits.into_iter().rev() {
        out = crate::splice::splice(&out, s, e, v.as_bytes());
    }
    let text_links = Ctx {
        strict_ext: false,
        ..*cx
    };
    if String::from_utf8_lossy(&out).contains("textlink=") {
        out = shift_element(&out, &text_links)?.unwrap_or(out);
    }
    Ok(out)
}

/// A legacy VML drawing (the notes' boxes) shifted: each note's
/// `<x:Row>`/`<x:Column>` and `<x:Anchor>` move; a note on a deleted cell
/// goes. VML is read as text (Office's VML is not always well-formed XML).
fn shift_vml(bytes: &[u8], cx: &Ctx<'_>) -> Result<Vec<u8>, Unshiftable> {
    let s = String::from_utf8_lossy(bytes).into_owned();
    let rows = cx.rows();
    let (tag, other) = if rows {
        ("x:Row", "x:Column")
    } else {
        ("x:Column", "x:Row")
    };
    let _ = other;
    let mut out = String::with_capacity(s.len());
    let mut rest = s.as_str();
    while let Some(i) = rest.find("<v:shape ") {
        out.push_str(&rest[..i]);
        let tail = &rest[i..];
        let Some(end) = tail.find("</v:shape>").map(|e| e + "</v:shape>".len()) else {
            out.push_str(tail);
            rest = "";
            break;
        };
        let shape = &tail[..end];
        rest = &tail[end..];
        let open = format!("<{tag}>");
        let close = format!("</{tag}>");
        let (Some(a), Some(b)) = (shape.find(&open), shape.find(&close)) else {
            out.push_str(shape);
            continue;
        };
        let Ok(v) = shape[a + open.len()..b].trim().parse::<u32>() else {
            out.push_str(shape);
            continue;
        };
        match shift_index(&cx.ts.edit, v) {
            None => {} // the note's cell is deleted: the box goes with it
            Some(n) => {
                let mut shape = format!("{}{n}{}", &shape[..a + open.len()], &shape[b..]);
                // `<x:Anchor>c1, dx1, r1, dy1, c2, dx2, r2, dy2</x:Anchor>`.
                if let (Some(p), Some(q)) = (shape.find("<x:Anchor>"), shape.find("</x:Anchor>")) {
                    let body = &shape[p + "<x:Anchor>".len()..q];
                    let mut nums: Vec<String> =
                        body.split(',').map(|x| x.trim().to_string()).collect();
                    if nums.len() == 8 {
                        for i in if rows { [2, 6] } else { [0, 4] } {
                            if let Ok(x) = nums[i].parse::<u32>() {
                                let nx = (x as i64 + n as i64 - v as i64).max(0);
                                nums[i] = nx.to_string();
                            }
                        }
                        shape = format!(
                            "{}{}{}",
                            &shape[..p + "<x:Anchor>".len()],
                            nums.join(", "),
                            &shape[q..]
                        );
                    }
                }
                out.push_str(&shape);
            }
        }
    }
    out.push_str(rest);
    Ok(out.into_bytes())
}

/// The changes a structural edit makes to the package, planned before any
/// is applied.
#[derive(Default)]
struct Plan {
    /// `(binding index, capture index, new bytes or None to drop)`.
    captured: Vec<(usize, usize, Option<Vec<u8>>)>,
    parts: Vec<(String, Vec<u8>)>,
    /// Table parts the edit deletes whole: `(part, owner .rels, rel id)`.
    removed_tables: Vec<(String, String, String)>,
    blockers: Vec<String>,
}

impl Plan {
    fn refuse(&mut self, what: &str, why: Unshiftable) {
        self.blockers.push(format!("{what}: {why}"));
    }
}

impl XlsxDocument {
    /// Shift the preserved content of the package for a row/column insert
    /// or delete on `edit`'s sheet (`sheet_names`: every sheet's name, by id)
    /// and record the edit for the save. On success returns the sheets
    /// whose parts changed (to be written on the next save). REFUSES with
    /// the named blockers — the package untouched — when something cannot
    /// be shifted (see the module docs); the caller must not apply the edit
    /// to its model then.
    pub fn shift_for_edit(
        &mut self,
        sheet_names: &[String],
        edit: Edit,
    ) -> Result<Vec<SheetId>, Vec<String>> {
        let plan = self.plan_shift(sheet_names, edit);
        if !plan.blockers.is_empty() {
            let mut b = plan.blockers;
            b.sort();
            b.dedup();
            return Err(b);
        }
        let target = edit_sheet(&edit);
        let mut dirty: BTreeSet<SheetId> = BTreeSet::new();
        dirty.insert(target);
        let mut drops: Vec<(usize, usize)> = Vec::new();
        for (bi, ci, new) in plan.captured {
            dirty.insert(self.bindings[bi].sheet_id);
            match new {
                Some(bytes) => self.bindings[bi].captured.items[ci].bytes = bytes,
                None => drops.push((bi, ci)),
            }
        }
        drops.sort();
        for (bi, ci) in drops.into_iter().rev() {
            self.bindings[bi].captured.items.remove(ci);
        }
        for (name, bytes) in plan.parts {
            self.set_part_bytes(&name, bytes);
        }
        for (part, rels, id) in plan.removed_tables {
            self.container.parts.retain(|p| p.name() != part);
            // Both refusals mean the entry is already absent.
            let _ = self.remove_rel(&rels, &id);
            let _ = self.remove_override(&part);
            self.container.dirty = true;
        }
        self.record_structural_edit(target, edit);
        self.refresh_derived(&dirty);
        // Charts the session holds (read or authored) follow their ranges.
        // (The chart parts' own `c:f` text is shifted with the other parts
        // below, so a parsed chart need not be spliced for it.)
        for ch in &mut self.charts {
            for p in &mut ch.model.plots {
                for s in &mut p.series {
                    s.map_ranges(|r| sheet_parser::shift_range_ref(r, &edit).or(Some(r)));
                }
            }
        }
        // Sparklines follow their data and their cells too.
        for groups in self.sparklines.values_mut() {
            for g in groups.iter_mut() {
                g.sparklines.retain_mut(|(data, at)| {
                    let cell = sheet_core::RangeRef {
                        start: *at,
                        end: *at,
                    };
                    let Some(moved) = sheet_parser::shift_range_ref(cell, &edit) else {
                        return false;
                    };
                    *at = moved.start;
                    if let Some(d) = sheet_parser::shift_range_ref(*data, &edit) {
                        *data = d;
                    }
                    true
                });
            }
        }
        Ok(dirty.into_iter().collect())
    }

    fn plan_shift(&self, sheet_names: &[String], edit: Edit) -> Plan {
        let mut plan = Plan::default();
        let target = edit_sheet(&edit);
        let Some(name) = sheet_names.get(target as usize) else {
            plan.blockers.push(format!("no sheet {target}"));
            return plan;
        };
        let cx_for = |host: bool| Ctx {
            ts: TextShift {
                edit,
                sheet_name: name,
                host_is_target: host,
                sheets: sheet_names,
            },
            strict_ext: true,
        };

        // 1. Every sheet's captured worksheet children.
        for (bi, b) in self.bindings.iter().enumerate() {
            let cx = cx_for(b.sheet_id == target);
            for (ci, c) in b.captured.items.iter().enumerate() {
                let what = crate::write::captured_local(&c.bytes);
                match shift_element(&c.bytes, &cx) {
                    Ok(Some(bytes)) if bytes == c.bytes => {}
                    Ok(new) => plan.captured.push((bi, ci, new)),
                    Err(e) => plan.refuse(&format!("<{what}>"), e),
                }
            }
        }

        // 2. The parts the edited sheet owns.
        if let Some(b) = self.bindings.iter().find(|b| b.sheet_id == target) {
            let rels_name = rels_part_name(&b.part_name);
            let base = part_dir(&b.part_name);
            if let Some(rels) = self
                .container
                .part(&rels_name)
                .and_then(|p| parse_rels(p.bytes()).ok())
            {
                let cx = cx_for(true);
                for r in &rels.items {
                    if r.target_mode.as_deref() == Some("External") {
                        continue;
                    }
                    let part = resolve_target(base, &r.target);
                    let Some(bytes) = self.part_bytes(&part) else {
                        continue;
                    };
                    let kind = r.rel_type.rsplit('/').next().unwrap_or("");
                    let result = match kind {
                        "table" => match shift_table_part(&bytes, target, &cx) {
                            Ok(Some(b)) => Ok(b),
                            Ok(None) => {
                                plan.removed_tables.push((
                                    part.clone(),
                                    rels_name.clone(),
                                    r.id.clone(),
                                ));
                                Ok(bytes.clone())
                            }
                            Err(e) => Err(e),
                        },
                        "drawing" => shift_drawing(&bytes, &cx),
                        "vmlDrawing" => shift_vml(&bytes, &cx),
                        "comments" | "threadedComment" => {
                            shift_element(&bytes, &cx).map(|o| o.unwrap_or(bytes.clone()))
                        }
                        "pivotTable" => Err(Unshiftable(
                            "a pivot table on the sheet (pivot tables are preserved, never \
                             moved — ADR 504)"
                                .into(),
                        )),
                        _ => Ok(bytes.clone()),
                    };
                    match result {
                        Ok(new) if new == bytes => {}
                        Ok(new) => plan.parts.push((part, new)),
                        Err(e) => plan.refuse(&format!("{kind} part {part}"), e),
                    }
                }
            }
        }

        // A table deleted whole leaves `<tableParts>` too.
        if !plan.removed_tables.is_empty() {
            if let Some((bi, b)) = self
                .bindings
                .iter()
                .enumerate()
                .find(|(_, b)| b.sheet_id == target)
            {
                let ids: Vec<String> = plan.removed_tables.iter().map(|t| t.2.clone()).collect();
                let gone: Vec<&str> = ids.iter().map(String::as_str).collect();
                for (ci, c) in b.captured.items.iter().enumerate() {
                    if crate::write::captured_local(&c.bytes) != "tableParts" {
                        continue;
                    }
                    match without_table_parts(&c.bytes, &gone) {
                        Ok(new) => {
                            plan.captured.retain(|(x, y, _)| (*x, *y) != (bi, ci));
                            plan.captured.push((bi, ci, new));
                        }
                        Err(e) => plan.refuse("<tableParts>", e),
                    }
                }
            }
        }

        // 3. Tables on other sheets (their formulas may name this sheet), every
        // chart, and the pivot caches.
        let cx = cx_for(false);
        for b in self.bindings.iter().filter(|b| b.sheet_id != target) {
            let rels_name = rels_part_name(&b.part_name);
            let base = part_dir(&b.part_name);
            let Some(rels) = self
                .container
                .part(&rels_name)
                .and_then(|p| parse_rels(p.bytes()).ok())
            else {
                continue;
            };
            for r in rels.all_of_type(crate::rels::REL_TABLE) {
                let part = resolve_target(base, &r.target);
                let Some(bytes) = self.part_bytes(&part) else {
                    continue;
                };
                match shift_table_part(&bytes, b.sheet_id, &cx) {
                    Ok(Some(new)) if new == bytes => {}
                    Ok(Some(new)) => plan.parts.push((part, new)),
                    Ok(None) => {}
                    Err(e) => plan.refuse(&format!("table part {part}"), e),
                }
            }
        }
        let chart_cx = Ctx {
            strict_ext: false,
            ..cx
        };
        for p in &self.container.parts {
            let pname = p.name();
            let is_chart = pname.starts_with("xl/charts/")
                && pname.ends_with(".xml")
                && !pname.contains("/_rels/")
                && (pname.contains("/chart")
                    && !pname.contains("/colors")
                    && !pname.contains("/style"));
            if is_chart {
                match shift_element(p.bytes(), &chart_cx) {
                    Ok(Some(new)) if new == p.bytes() => {}
                    Ok(Some(new)) => plan.parts.push((pname.to_string(), new)),
                    Ok(None) => {}
                    Err(e) => plan.refuse(&format!("chart {pname}"), e),
                }
            }
            if pname.starts_with("xl/pivotCache/pivotCacheDefinition") && pname.ends_with(".xml") {
                if let Some(src) = worksheet_source_sheet(p.bytes()) {
                    if src.eq_ignore_ascii_case(name) {
                        plan.blockers.push(format!(
                            "the pivot cache {pname} reads this sheet (pivot tables are \
                             preserved, never moved — ADR 504)"
                        ));
                    }
                }
            }
        }

        // 4. Defined names (print areas and titles included).
        if let Ok(wb) = self.workbook_bytes() {
            match shift_defined_names(&wb, name, sheet_names, target, edit) {
                Ok(Some(new)) => plan.parts.push((self.workbook_part.clone(), new)),
                Ok(None) => {}
                Err(e) => plan.refuse("a defined name", e),
            }
        }
        plan
    }

    /// Re-derive the read-only models of `sheets` from their (shifted)
    /// captures and parts.
    fn refresh_derived(&mut self, sheets: &BTreeSet<SheetId>) {
        for b in self
            .bindings
            .iter()
            .filter(|b| sheets.contains(&b.sheet_id))
        {
            let sid = b.sheet_id;
            match crate::parts::conditional_format::parse_all(
                b.captured.after().map(|c| c.bytes.as_slice()),
            ) {
                Ok(cf) if !cf.is_empty() => {
                    self.conditional_formats.insert(sid, cf);
                }
                _ => {
                    self.conditional_formats.remove(&sid);
                }
            }
            match crate::parts::data_validation::parse_all(
                b.captured.after().map(|c| c.bytes.as_slice()),
            ) {
                Ok(dv) if !dv.is_empty() => {
                    self.data_validations.insert(sid, dv);
                }
                _ => {
                    self.data_validations.remove(&sid);
                }
            }
            match crate::parts::freeze::parse_all(b.captured.before().map(|c| c.bytes.as_slice())) {
                Ok(Some(fp)) => {
                    self.freeze_panes.insert(sid, fp);
                }
                _ => {
                    self.freeze_panes.remove(&sid);
                }
            }
            let rels_name = rels_part_name(&b.part_name);
            let comments = self
                .container
                .part(&rels_name)
                .and_then(|p| parse_rels(p.bytes()).ok())
                .and_then(|rels| {
                    rels.by_type_suffix(crate::rels::REL_COMMENTS)
                        .map(|r| resolve_target(part_dir(&b.part_name), &r.target))
                })
                .and_then(|part| self.container.part(&part))
                .and_then(|p| crate::parts::comments::parse(p.bytes()).ok());
            match comments {
                Some(c) if !c.is_empty() => {
                    self.comments.insert(sid, c);
                }
                _ => {
                    self.comments.remove(&sid);
                }
            }
        }
    }
}

/// A `<tableParts>` element without the `<tablePart>`s whose `r:id` is in
/// `gone` (`None`: none left).
fn without_table_parts(bytes: &[u8], gone: &[&str]) -> Result<Option<Vec<u8>>, Unshiftable> {
    let root = root_span(bytes)?;
    let (kids, close) = children_of(bytes, &root).map_err(xml_err)?;
    let mut body = String::new();
    let mut kept = 0usize;
    for k in &kids {
        let a = attrs_of(bytes, k).map_err(xml_err)?;
        if attr_local(&a, "id").is_some_and(|id| gone.contains(&id.as_str())) {
            continue;
        }
        kept += 1;
        body.push_str(&String::from_utf8_lossy(&bytes[k.start..k.end]));
    }
    if kept == 0 {
        return Ok(None);
    }
    let mut a = attrs_of(bytes, &root).map_err(xml_err)?;
    set_attr(&mut a, "count", Some(kept.to_string()));
    let mut s = render_tag(&root.qname, &a, false);
    s.push_str(&body);
    s.push_str(&String::from_utf8_lossy(&bytes[close..root.end]));
    Ok(Some(s.into_bytes()))
}

/// The sheet an edit works on.
fn edit_sheet(edit: &Edit) -> SheetId {
    match *edit {
        Edit::InsertRows { sheet, .. }
        | Edit::DeleteRows { sheet, .. }
        | Edit::InsertCols { sheet, .. }
        | Edit::DeleteCols { sheet, .. } => sheet,
    }
}

/// The `sheet` a pivot cache's `<worksheetSource>` reads, if any.
fn worksheet_source_sheet(xml: &[u8]) -> Option<String> {
    use quick_xml::events::Event;
    let mut reader = quick_xml::Reader::from_reader(xml);
    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf).ok()? {
            Event::Start(e) | Event::Empty(e) if e.local_name().as_ref() == b"worksheetSource" => {
                return crate::opc::attr(&e, b"sheet").ok().flatten();
            }
            Event::Eof => return None,
            _ => {}
        }
        buf.clear();
    }
}

/// The workbook part with every `<definedName>` that names the edited
/// sheet's cells shifted (`None`: none did). A sheet-scoped name's
/// unqualified references are on its own sheet.
fn shift_defined_names(
    wb: &[u8],
    name: &str,
    sheets: &[String],
    target: SheetId,
    edit: Edit,
) -> Result<Option<Vec<u8>>, Unshiftable> {
    let (kids, _) = root_children(wb).map_err(xml_err)?;
    let Some(dn) = kids.iter().find(|k| k.local == "definedNames") else {
        return Ok(None);
    };
    let (items, _) = children_of(wb, dn).map_err(xml_err)?;
    let mut out = wb.to_vec();
    let mut changed = false;
    for item in items
        .iter()
        .rev()
        .filter(|s| s.local == "definedName" && !s.empty)
    {
        let a = attrs_of(wb, item).map_err(xml_err)?;
        let local = attr_local(&a, "localSheetId").and_then(|v| v.parse::<u32>().ok());
        let text = leaf_text(wb, item);
        let ts = TextShift {
            edit,
            sheet_name: name,
            host_is_target: local == Some(target as u32),
            sheets,
        };
        let new = shift_ref_text(&text, &ts).map_err(|e| {
            Unshiftable(format!(
                "{} ({e})",
                attr_local(&a, "name").unwrap_or_default()
            ))
        })?;
        if new != text {
            let close = item.end - format!("</{}>", item.qname).len();
            out = crate::splice::splice(
                &out,
                item.tag_end,
                close,
                paged_ooxml::xml::escape_text(&new).as_bytes(),
            );
            changed = true;
        }
    }
    Ok(changed.then_some(out))
}

#[cfg(test)]
#[allow(non_snake_case)]
mod tests {
    use super::*;

    fn cx(edit: Edit, host: bool) -> Ctx<'static> {
        Ctx {
            ts: TextShift {
                edit,
                sheet_name: "Data",
                host_is_target: host,
                sheets: &[],
            },
            strict_ext: true,
        }
    }
    const INS2: Edit = Edit::InsertRows {
        sheet: 0,
        at: 1,
        n: 2,
    };
    const DEL_B: Edit = Edit::DeleteCols {
        sheet: 0,
        at: 1,
        n: 1,
    };

    fn run(xml: &str, edit: Edit, host: bool) -> Option<String> {
        shift_element(xml.as_bytes(), &cx(edit, host))
            .unwrap()
            .map(|b| String::from_utf8(b).unwrap())
    }

    #[test]
    fn conditional_formats_and_validations_shift_their_ranges_and_formulas__feat__sheet_calc_rewrite_structural_door(
    ) {
        assert_eq!(
            run(
                r#"<conditionalFormatting sqref="A2:A9 C3"><cfRule type="expression" priority="1"><formula>A2&gt;$B$1</formula></cfRule></conditionalFormatting>"#,
                INS2,
                true
            )
            .as_deref(),
            Some(
                r#"<conditionalFormatting sqref="A4:A11 C5"><cfRule type="expression" priority="1"><formula>A4&gt;$B$1</formula></cfRule></conditionalFormatting>"#
            )
        );
        // A rule whose cells are all deleted goes; the count follows.
        assert_eq!(
            run(
                r#"<dataValidations count="2"><dataValidation type="list" sqref="B1:B5"><formula1>$D$1:$D$3</formula1></dataValidation><dataValidation type="whole" sqref="A1:C1"><formula1>C1</formula1></dataValidation></dataValidations>"#,
                DEL_B,
                true
            )
            .as_deref(),
            Some(
                r#"<dataValidations count="1"><dataValidation type="whole" sqref="A1:B1"><formula1>B1</formula1></dataValidation></dataValidations>"#
            )
        );
        assert_eq!(
            run(
                r#"<hyperlinks><hyperlink ref="B2" r:id="rId1"/></hyperlinks>"#,
                DEL_B,
                true
            ),
            None
        );
        // On another sheet only qualified references move.
        assert_eq!(
            run(
                r#"<dataValidations count="1"><dataValidation sqref="A2"><formula1>Data!$A$2:$A$9</formula1></dataValidation></dataValidations>"#,
                INS2,
                false
            )
            .as_deref(),
            Some(
                r#"<dataValidations count="1"><dataValidation sqref="A2"><formula1>Data!$A$4:$A$11</formula1></dataValidation></dataValidations>"#
            )
        );
    }

    #[test]
    fn extensions_sparklines_and_unknown_content__feat__sheet_calc_rewrite_structural_door() {
        let spark = r#"<extLst><ext uri="{05C60535-1F16-4fd2-B633-F4F36F0B64E0}" xmlns:x14="u"><x14:sparklineGroups xmlns:xm="m"><x14:sparklineGroup><x14:sparklines><x14:sparkline><xm:f>Data!A2:E2</xm:f><xm:sqref>F2</xm:sqref></x14:sparkline><x14:sparkline><xm:f>Data!A3:E3</xm:f><xm:sqref>F3</xm:sqref></x14:sparkline></x14:sparklines></x14:sparklineGroup></x14:sparklineGroups></ext></extLst>"#;
        let out = run(spark, INS2, true).unwrap();
        assert!(
            out.contains("<xm:f>Data!A4:E4</xm:f><xm:sqref>F4</xm:sqref>"),
            "{out}"
        );
        let gone = run(
            spark,
            Edit::DeleteRows {
                sheet: 0,
                at: 1,
                n: 2,
            },
            true,
        );
        assert_eq!(
            gone, None,
            "every sparkline gone takes the extension with it"
        );
        let unknown = r#"<extLst><ext uri="{00000000-0000-0000-0000-000000000000}"><y:thing><xm:sqref>A1</xm:sqref></y:thing></ext></extLst>"#;
        assert!(shift_element(unknown.as_bytes(), &cx(INS2, true)).is_err());
        let harmless = r#"<extLst><ext uri="{00000000-0000-0000-0000-000000000000}"><y:thing a="1"/></ext></extLst>"#;
        assert_eq!(run(harmless, INS2, true).as_deref(), Some(harmless));
    }

    #[test]
    fn views_breaks_and_filters__feat__sheet_calc_rewrite_structural_door() {
        assert_eq!(
            run(
                r#"<sheetViews><sheetView workbookViewId="0"><selection activeCell="B3" sqref="B3"/></sheetView></sheetViews>"#,
                Edit::DeleteRows {
                    sheet: 0,
                    at: 1,
                    n: 5
                },
                true
            )
            .as_deref(),
            Some(
                r#"<sheetViews><sheetView workbookViewId="0"><selection activeCell="B2" sqref="B2"/></sheetView></sheetViews>"#
            )
        );
        assert_eq!(
            run(
                r#"<rowBreaks count="2" manualBreakCount="2"><brk id="1" max="16383" man="1"/><brk id="5" max="16383" man="1"/></rowBreaks>"#,
                Edit::DeleteRows {
                    sheet: 0,
                    at: 1,
                    n: 1
                },
                true
            )
            .as_deref(),
            Some(
                r#"<rowBreaks count="1" manualBreakCount="1"><brk id="4" max="16383" man="1"/></rowBreaks>"#
            )
        );
        assert_eq!(
            run(
                r#"<autoFilter ref="B1:E9"><filterColumn colId="0"><filters><filter val="x"/></filters></filterColumn><filterColumn colId="2"><filters><filter val="y"/></filters></filterColumn></autoFilter>"#,
                Edit::DeleteCols {
                    sheet: 0,
                    at: 2,
                    n: 1
                },
                true
            )
            .as_deref(),
            Some(
                r#"<autoFilter ref="B1:D9"><filterColumn colId="0"><filters><filter val="x"/></filters></filterColumn><filterColumn colId="1"><filters><filter val="y"/></filters></filterColumn></autoFilter>"#
            )
        );
    }

    #[test]
    fn tables_grow_and_name_new_columns__feat__sheet_calc_rewrite_structural_door() {
        let t = r#"<table xmlns="m" id="1" name="T" displayName="T" ref="A1:C4"><autoFilter ref="A1:C4"/><tableColumns count="3"><tableColumn id="1" name="A"/><tableColumn id="2" name="B"/><tableColumn id="3" name="C"><calculatedColumnFormula>T[[#This Row],[A]]+B2</calculatedColumnFormula></tableColumn></tableColumns></table>"#;
        let out = shift_table_part(
            t.as_bytes(),
            0,
            &cx(
                Edit::InsertCols {
                    sheet: 0,
                    at: 1,
                    n: 1,
                },
                true,
            ),
        )
        .unwrap()
        .unwrap();
        let out = String::from_utf8(out).unwrap();
        assert!(out.contains(r#"ref="A1:D4""#), "{out}");
        assert!(
            out.contains(r#"<tableColumns count="4"><tableColumn id="1" name="A"/><tableColumn id="4" name="Column1"/><tableColumn id="2" name="B"/>"#),
            "{out}"
        );
        assert!(out.contains("[A]]+C2</calculatedColumnFormula>"), "{out}");
        assert!(shift_table_part(
            t.as_bytes(),
            0,
            &cx(
                Edit::DeleteRows {
                    sheet: 0,
                    at: 0,
                    n: 10
                },
                true
            )
        )
        .unwrap()
        .is_none());
    }

    #[test]
    fn drawings_move_and_size_by_edit_as__feat__sheet_calc_rewrite_structural_door() {
        let d = r#"<xdr:wsDr xmlns:xdr="x"><xdr:twoCellAnchor><xdr:from><xdr:col>1</xdr:col><xdr:colOff>5</xdr:colOff><xdr:row>2</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>4</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>9</xdr:row><xdr:rowOff>7</xdr:rowOff></xdr:to></xdr:twoCellAnchor><xdr:twoCellAnchor editAs="oneCell"><xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>3</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>1</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>5</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to></xdr:twoCellAnchor><xdr:twoCellAnchor editAs="absolute"><xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>3</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>1</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>5</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to></xdr:twoCellAnchor></xdr:wsDr>"#;
        let out = String::from_utf8(shift_drawing(d.as_bytes(), &cx(INS2, true)).unwrap()).unwrap();
        // Move and size: both corners move (the insert is inside: it grows).
        assert!(out.contains("<xdr:row>4</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>4</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>11</xdr:row>"), "{out}");
        // Move only: the far corner keeps its distance; absolute stays.
        assert!(out.contains("<xdr:row>5</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>1</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>7</xdr:row>"), "{out}");
        assert!(out.ends_with("<xdr:row>3</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>1</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>5</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to></xdr:twoCellAnchor></xdr:wsDr>"), "{out}");
    }

    #[test]
    fn notes_and_their_boxes_follow_their_cells__feat__sheet_calc_rewrite_structural_door() {
        let c = r#"<comments xmlns="m"><authors><author>a</author></authors><commentList><comment ref="B2" authorId="0"><text><t>x</t></text></comment><comment ref="C3" authorId="0"><text><t>y</t></text></comment></commentList></comments>"#;
        let out = run(c, DEL_B, true).unwrap();
        assert!(
            !out.contains(r#"ref="B2""#) && out.contains(r#"<comment ref="B3""#),
            "{out}"
        );
        let v = r#"<xml><v:shape id="a"><x:ClientData ObjectType="Note"><x:Anchor>2, 15, 1, 10, 4, 15, 5, 4</x:Anchor><x:Row>1</x:Row><x:Column>1</x:Column></x:ClientData></v:shape><v:shape id="b"><x:ClientData ObjectType="Note"><x:Anchor>3, 15, 2, 10, 5, 15, 6, 4</x:Anchor><x:Row>2</x:Row><x:Column>2</x:Column></x:ClientData></v:shape></xml>"#;
        let out = String::from_utf8(shift_vml(v.as_bytes(), &cx(DEL_B, true)).unwrap()).unwrap();
        assert!(!out.contains(r#"id="a""#), "{out}");
        assert!(out.contains("<x:Anchor>2, 15, 2, 10, 4, 15, 6, 4</x:Anchor><x:Row>2</x:Row><x:Column>1</x:Column>"), "{out}");
    }

    #[test]
    fn defined_names_shift_and_unreadable_ones_refuse__feat__sheet_calc_rewrite_structural_door() {
        let wb = br#"<workbook><sheets/><definedNames><definedName name="_xlnm.Print_Area" localSheetId="0">Data!$A$1:$D$20</definedName><definedName name="Other">Other!$A$1</definedName><definedName name="Local" localSheetId="0">$B$2</definedName></definedNames></workbook>"#;
        let out = String::from_utf8(
            shift_defined_names(wb, "Data", &[], 0, INS2)
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert!(out.contains(">Data!$A$1:$D$22<"), "{out}");
        assert!(
            out.contains(">Other!$A$1<") && out.contains(">$B$4<"),
            "{out}"
        );
        assert!(shift_defined_names(
            br#"<workbook><definedNames><definedName name="x">"open</definedName></definedNames></workbook>"#,
            "Data",
            &[],
            0,
            INS2
        )
        .is_err());
    }
}
