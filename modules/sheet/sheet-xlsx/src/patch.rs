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

//! Saving an edited worksheet by PATCHING its part (ADR 503, W1.4).
//!
//! The part as read is the base; the save changes only what the model
//! changed, in place:
//!
//! - `<sheetData>` row by row: a row whose cells, height, visibility and
//!   row attributes all still read as they were is copied byte for byte. A
//!   changed row keeps its start tag (unknown attributes such as
//!   `x14ac:dyDescent` survive; `r`, `ht`, `hidden`, `s`, `outlineLevel` …
//!   are set from the model) and, cell by cell, the same rule again: an
//!   unchanged `<c>` is copied, a changed one keeps its start tag (`ph`,
//!   `vm`, unknown attributes) with `t`/`s`/`cm` set and `<f>`/`<v>`/`<is>`
//!   replaced. A text cell whose text is still its shared string keeps
//!   `t="s"` and the index, so rich-text runs in `sharedStrings.xml` stay.
//! - `<dimension>`, `<cols>` and `<mergeCells>` are rewritten only when the
//!   model's differ from what the part holds.
//! - The captured children (preserve.rs) are spliced back where they stood;
//!   only those a structural edit rewrote change.
//!
//! A row/column insert or delete is recorded on the sheet's binding
//! (`SheetBinding::edits`), so each row and cell of the part is found again
//! at its new address: a moved row is rewritten with its own attributes, not
//! regenerated from a model that never held them. Shared formulas whose
//! group a change touches are written out cell by cell (`<f>` per member),
//! the one form whose meaning does not depend on the master.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use compact_str::CompactString;
use paged_ooxml::xml::escape_text;
use sheet_core::value::CellValue;
use sheet_core::{col_to_a1, ColMeta, RowMeta, SheetId, SheetModel, Worksheet};

use crate::error::XlsxError;
use crate::parts::worksheet::{parse_cols, parse_range, resolve_value};
use crate::sheet_doc::SheetBinding;
use crate::splice::{attr_local, attrs_of, children_of, render_tag, root_children, set_attr, Span};
use crate::write::{captured_local, fmt_f64, stored_error, DynamicArrays, BEFORE_MERGE_CELLS};

/// Everything a worksheet patch reads.
pub(crate) struct PatchInput<'a> {
    pub model: &'a SheetModel,
    pub binding: &'a SheetBinding,
    /// The part's bytes as read (or as a structure write left them).
    pub original: &'a [u8],
    pub formula_texts: &'a BTreeMap<(SheetId, u32, u32), String>,
    pub dynamic: &'a DynamicArrays<'a>,
    /// The workbook's shared strings as read (`t="s"` indexes).
    pub shared: &'a [CompactString],
}

/// How an original `<f>` stores its formula.
#[derive(Clone, Debug, PartialEq)]
enum FKind {
    Normal,
    Shared { si: u32 },
    Array { area: (u32, u32) },
}

/// One `<c>` of the part as read.
struct OCell {
    row: u32,
    col: u32,
    span: Span,
    attrs: Vec<(String, String)>,
    ty: String,
    style: u32,
    cm: Option<u32>,
    /// The `<f>` element's span and kind.
    f: Option<(Span, FKind)>,
    /// The resolved formula text (a shared member's shifted master text).
    formula: Option<String>,
    v: String,
    /// `<is>`: its span and its text.
    inline: Option<(Span, String)>,
    /// Other children (`<extLst>` …), kept in order.
    extra: Vec<Span>,
}

/// One `<row>` of the part as read.
struct ORow {
    row: u32,
    span: Span,
    attrs: Vec<(String, String)>,
    cells: Vec<OCell>,
    extra: Vec<Span>,
    /// The bytes between the previous sibling and this row (indentation).
    lead: (usize, usize),
}

fn truthy(v: Option<String>) -> bool {
    v.is_some_and(|v| v == "1" || v == "true")
}

/// The unescaped text content of a leaf element.
fn leaf_text(xml: &[u8], span: &Span) -> String {
    if span.empty {
        return String::new();
    }
    let close = format!("</{}>", span.qname);
    let end = span.end.saturating_sub(close.len()).max(span.tag_end);
    let raw = String::from_utf8_lossy(&xml[span.tag_end..end]);
    quick_xml::escape::unescape(&raw)
        .map(|c| c.into_owned())
        .unwrap_or_else(|_| raw.into_owned())
}

/// The displayed text of an `<is>` (every `<t>` outside `<rPh>`).
fn inline_text(bytes: &[u8]) -> String {
    use quick_xml::events::Event;
    let mut reader = quick_xml::Reader::from_reader(bytes);
    reader.config_mut().trim_text(false);
    let mut buf = Vec::new();
    let (mut in_t, mut in_rph) = (false, false);
    let mut out = String::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => match e.local_name().as_ref() {
                b"t" if !in_rph => in_t = true,
                b"rPh" => in_rph = true,
                _ => {}
            },
            Ok(Event::End(e)) => match e.local_name().as_ref() {
                b"t" => in_t = false,
                b"rPh" => in_rph = false,
                _ => {}
            },
            Ok(Event::Text(t)) if in_t => {
                if let Ok(s) = t.xml10_content() {
                    out.push_str(&s);
                }
            }
            Ok(Event::GeneralRef(r)) if in_t => {
                if let Ok(s) = crate::opc::general_ref(&r) {
                    out.push_str(&s);
                }
            }
            Ok(Event::CData(c)) if in_t => out.push_str(&String::from_utf8_lossy(&c.into_inner())),
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    out
}

/// Read the rows of `<sheetData>` (shared-formula members resolved as the
/// reader resolves them).
fn scan_rows(xml: &[u8], sheet_data: &Span) -> Result<(Vec<ORow>, Vec<Span>), XlsxError> {
    let (kids, _) = children_of(xml, sheet_data)?;
    let mut rows = Vec::new();
    let mut other = Vec::new();
    let mut prev_end = sheet_data.tag_end;
    let mut masters: BTreeMap<u32, (String, u32, u32)> = BTreeMap::new();
    for k in kids {
        if k.local != "row" {
            other.push(k.clone());
            prev_end = k.end;
            continue;
        }
        let attrs = attrs_of(xml, &k)?;
        let row = attr_local(&attrs, "r")
            .and_then(|s| s.parse::<u32>().ok())
            .map(|r| r.saturating_sub(1))
            .unwrap_or_else(|| rows.last().map_or(0, |r: &ORow| r.row + 1));
        let mut cells = Vec::new();
        let mut extra = Vec::new();
        let (ckids, _) = children_of(xml, &k)?;
        let mut next_col = 0u32;
        for c in ckids {
            if c.local != "c" {
                extra.push(c);
                continue;
            }
            let cattrs = attrs_of(xml, &c)?;
            let (crow, col) = match attr_local(&cattrs, "r")
                .as_deref()
                .and_then(sheet_core::parse_a1)
            {
                Some((r, col, _, _)) => (r, col),
                None => (row, next_col),
            };
            next_col = col + 1;
            let mut cell = OCell {
                row: crow,
                col,
                ty: attr_local(&cattrs, "t").unwrap_or_default(),
                style: attr_local(&cattrs, "s")
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(0),
                cm: attr_local(&cattrs, "cm").and_then(|s| s.parse().ok()),
                attrs: cattrs,
                span: c.clone(),
                f: None,
                formula: None,
                v: String::new(),
                inline: None,
                extra: Vec::new(),
            };
            let (gkids, _) = children_of(xml, &c)?;
            for g in gkids {
                match g.local.as_str() {
                    "f" => {
                        let fa = attrs_of(xml, &g)?;
                        let text = leaf_text(xml, &g);
                        let si = attr_local(&fa, "si").and_then(|s| s.parse::<u32>().ok());
                        let kind = match attr_local(&fa, "t").as_deref() {
                            Some("shared") => match si {
                                Some(si) => FKind::Shared { si },
                                None => FKind::Normal,
                            },
                            Some("array") => FKind::Array {
                                area: attr_local(&fa, "ref")
                                    .as_deref()
                                    .and_then(parse_range)
                                    .map(|r| {
                                        let n = r.normalized();
                                        (n.rows(), n.cols())
                                    })
                                    .unwrap_or((1, 1)),
                            },
                            _ => FKind::Normal,
                        };
                        let formula = if !text.is_empty() {
                            if let (FKind::Shared { si }, true) =
                                (&kind, attr_local(&fa, "ref").is_some())
                            {
                                masters.insert(*si, (text.clone(), crow, col));
                            }
                            Some(text)
                        } else if let FKind::Shared { si } = &kind {
                            masters.get(si).map(|(t, mr, mc)| {
                                let (dr, dc) = (
                                    i64::from(crow) - i64::from(*mr),
                                    i64::from(col) - i64::from(*mc),
                                );
                                sheet_parser::shift_formula_text(t, dr, dc)
                                    .unwrap_or_else(|| t.clone())
                            })
                        } else {
                            None
                        };
                        cell.formula = formula;
                        cell.f = Some((g, kind));
                    }
                    "v" => cell.v = leaf_text(xml, &g),
                    "is" => {
                        let t = inline_text(&xml[g.start..g.end]);
                        cell.inline = Some((g, t));
                    }
                    _ => cell.extra.push(g),
                }
            }
            cells.push(cell);
        }
        rows.push(ORow {
            row,
            lead: (prev_end, k.start),
            span: k.clone(),
            attrs,
            cells,
            extra,
        });
        prev_end = k.end;
    }
    Ok((rows, other))
}

/// The address an original row/column has after the sheet's recorded
/// structural edits (`None`: deleted).
fn forward(edits: &[sheet_parser::Edit], mut row: u32, mut col: u32) -> Option<(u32, u32)> {
    for e in edits {
        if sheet_parser::edit_is_rows(e) {
            row = sheet_parser::shift_index(e, row)?;
        } else {
            col = sheet_parser::shift_index(e, col)?;
        }
    }
    Some((row, col))
}

/// How the model wants a formula cell stored.
#[derive(Clone, Copy, PartialEq)]
enum Form {
    None,
    Array { area: (u32, u32), cm: Option<u32> },
}

fn form_of(input: &PatchInput<'_>, ws: &Worksheet, r: u32, c: u32) -> Form {
    let sid = input.binding.sheet_id;
    match input.dynamic.anchors.get(&(sid, r, c)) {
        Some(&area) => Form::Array {
            area: (area.0.max(1), area.1.max(1)),
            cm: input.dynamic.cm,
        },
        None => match ws.array_formulas.get(&(r, c)) {
            Some(&area) => Form::Array {
                area: (area.0.max(1), area.1.max(1)),
                cm: None,
            },
            None => Form::None,
        },
    }
}

/// Whether the model's cell still reads exactly as the original one.
fn cell_unchanged(
    input: &PatchInput<'_>,
    o: &OCell,
    cell: &sheet_core::Cell,
    formula: Option<&String>,
    form: Form,
    broken: &BTreeSet<u32>,
) -> bool {
    if o.style != cell.style.0 || o.formula.as_ref() != formula {
        return false;
    }
    match (&o.f, form) {
        (Some((_, FKind::Shared { si })), Form::None) if broken.contains(si) => return false,
        (Some((_, FKind::Shared { .. })), Form::None) | (Some((_, FKind::Normal)), Form::None) => {}
        (None, Form::None) => {}
        (Some((_, FKind::Array { area })), Form::Array { area: want, cm }) => {
            if *area != want || cm.is_some() != (o.cm.is_some() && o.cm == input.dynamic.cm) {
                return false;
            }
        }
        _ => return false,
    }
    let inline_t = o.inline.as_ref().map_or("", |(_, t)| t.as_str());
    let was = resolve_value(&o.ty, &o.v, inline_t, input.shared).unwrap_or(CellValue::Empty);
    match (&was, &cell.value) {
        (CellValue::Error(a), CellValue::Error(b)) => stored_error(*a) == stored_error(*b),
        (a, b) => a == b,
    }
}

/// The patched `<c>` for a changed cell. `o` is the original cell at this
/// address (its start tag and unknown children are kept).
#[allow(clippy::too_many_arguments)]
fn render_cell(
    out: &mut String,
    xml: &[u8],
    prefix: &str,
    input: &PatchInput<'_>,
    o: Option<&OCell>,
    r: u32,
    c: u32,
    cell: &sheet_core::Cell,
    formula: Option<&String>,
    form: Form,
    broken: &BTreeSet<u32>,
) {
    let mut attrs: Vec<(String, String)> = o.map(|o| o.attrs.clone()).unwrap_or_default();
    let addr = format!("{}{}", col_to_a1(c), r + 1);
    if attrs.is_empty() {
        attrs.push(("r".into(), addr.clone()));
    } else {
        set_attr(&mut attrs, "r", Some(addr.clone()));
    }
    set_attr(
        &mut attrs,
        "s",
        (cell.style.0 != 0).then(|| cell.style.0.to_string()),
    );
    let value_changed = o.is_none_or(|o| {
        let inline_t = o.inline.as_ref().map_or("", |(_, t)| t.as_str());
        resolve_value(&o.ty, &o.v, inline_t, input.shared)
            .ok()
            .as_ref()
            != Some(&cell.value)
    });
    if value_changed {
        // A value-metadata pointer (an image in a cell) no longer applies.
        set_attr(&mut attrs, "vm", None);
    }

    // Type + value children.
    let mut value_xml = String::new();
    let t: Option<&str> = match &cell.value {
        CellValue::Empty => None,
        CellValue::Number(n) => {
            value_xml = format!("<{prefix}v>{}</{prefix}v>", fmt_f64(*n));
            None
        }
        CellValue::Bool(b) => {
            value_xml = format!("<{prefix}v>{}</{prefix}v>", u8::from(*b));
            Some("b")
        }
        CellValue::Error(e) => {
            value_xml = format!("<{prefix}v>{}</{prefix}v>", escape_text(stored_error(*e)));
            Some("e")
        }
        CellValue::Text(text) => {
            if formula.is_some() {
                value_xml = format!("<{prefix}v>{}</{prefix}v>", escape_text(text));
                Some("str")
            } else if let Some(idx) = o.and_then(|o| {
                (o.ty == "s")
                    .then(|| o.v.trim().parse::<usize>().ok())
                    .flatten()
                    .filter(|&i| input.shared.get(i).is_some_and(|s| s == text))
            }) {
                // Still its shared string: the index (and any rich runs).
                value_xml = format!("<{prefix}v>{idx}</{prefix}v>");
                Some("s")
            } else if let Some((span, _)) =
                o.and_then(|o| o.inline.as_ref().filter(|(_, t)| t == text.as_str()))
            {
                value_xml = String::from_utf8_lossy(&xml[span.start..span.end]).into_owned();
                Some("inlineStr")
            } else {
                let space = if text.starts_with(char::is_whitespace)
                    || text.ends_with(char::is_whitespace)
                {
                    r#" xml:space="preserve""#
                } else {
                    ""
                };
                value_xml = format!(
                    "<{prefix}is><{prefix}t{space}>{}</{prefix}t></{prefix}is>",
                    escape_text(text)
                );
                Some("inlineStr")
            }
        }
    };
    set_attr(&mut attrs, "t", t.map(str::to_string));

    // The formula child: the original element when it still says the same.
    let mut f_xml = String::new();
    if let Some(text) = formula {
        let reusable = o.and_then(|o| {
            let (span, kind) = o.f.as_ref()?;
            let same_text = o.formula.as_ref() == Some(text);
            let ok = same_text
                && match (kind, form) {
                    (FKind::Normal, Form::None) => true,
                    (FKind::Shared { si }, Form::None) => {
                        !broken.contains(si) && (o.row, o.col) == (r, c)
                    }
                    (FKind::Array { area }, Form::Array { area: want, .. }) => {
                        *area == want && (o.row, o.col) == (r, c)
                    }
                    _ => false,
                };
            ok.then(|| String::from_utf8_lossy(&xml[span.start..span.end]).into_owned())
        });
        f_xml = match reusable {
            Some(x) => x,
            None => match form {
                Form::Array {
                    area: (rows, cols), ..
                } => {
                    let area = if (rows, cols) == (1, 1) {
                        addr.clone()
                    } else {
                        format!(
                            "{addr}:{}{}",
                            col_to_a1(c.saturating_add(cols - 1)),
                            r.saturating_add(rows)
                        )
                    };
                    format!(
                        r#"<{prefix}f t="array" ref="{area}">{}</{prefix}f>"#,
                        escape_text(text)
                    )
                }
                Form::None => format!("<{prefix}f>{}</{prefix}f>", escape_text(text)),
            },
        };
    }
    // `cm`: the dynamic-array marker follows the model; any other cell
    // metadata the cell carried stays.
    match form {
        Form::Array { cm: Some(cm), .. } if formula.is_some() => {
            set_attr(&mut attrs, "cm", Some(cm.to_string()));
        }
        _ => {
            if o.is_some_and(|o| o.cm.is_some() && o.cm == input.dynamic.cm) {
                set_attr(&mut attrs, "cm", None);
            }
        }
    }

    let mut extra = String::new();
    if let Some(o) = o {
        for e in &o.extra {
            extra.push_str(&String::from_utf8_lossy(&xml[e.start..e.end]));
        }
    }
    let qname = format!("{prefix}c");
    if f_xml.is_empty() && value_xml.is_empty() && extra.is_empty() {
        out.push_str(&render_tag(&qname, &attrs, true));
    } else {
        out.push_str(&render_tag(&qname, &attrs, false));
        out.push_str(&f_xml);
        out.push_str(&value_xml);
        out.push_str(&extra);
        out.push_str(&format!("</{qname}>"));
    }
}

/// The row attributes the model asks for, starting from the original ones.
fn row_attrs(
    orig: Option<&[(String, String)]>,
    ws: &Worksheet,
    r: u32,
    cols: Option<(u32, u32)>,
) -> Vec<(String, String)> {
    let mut a: Vec<(String, String)> = orig.map(<[_]>::to_vec).unwrap_or_default();
    let r1 = (r + 1).to_string();
    if attr_local(&a, "r").as_deref() != Some(r1.as_str()) {
        if a.is_empty() {
            a.push(("r".into(), r1));
        } else {
            set_attr(&mut a, "r", Some(r1));
        }
    }
    // `spans` is a hint; drop it when the cells left it.
    if let Some(sp) = attr_local(&a, "spans") {
        let fits = match (cols, sp.split_once(':')) {
            (Some((lo, hi)), Some((x, y))) => {
                let (x, y) = (x.trim().parse::<u32>(), y.trim().parse::<u32>());
                matches!((x, y), (Ok(x), Ok(y)) if x >= 1 && lo + 1 >= x && hi < y)
            }
            (None, _) => true,
            _ => false,
        };
        if !fits {
            set_attr(&mut a, "spans", None);
        }
    }
    // Height.
    let custom = truthy(attr_local(&a, "customHeight"));
    let ht = attr_local(&a, "ht").and_then(|s| s.parse::<f64>().ok());
    match ws.row_heights.get(&r) {
        Some(&h) => {
            if !(custom && ht == Some(h)) {
                set_attr(&mut a, "ht", Some(fmt_f64(h)));
                set_attr(&mut a, "customHeight", Some("1".into()));
            }
        }
        None => {
            if custom {
                set_attr(&mut a, "ht", None);
                set_attr(&mut a, "customHeight", None);
            }
        }
    }
    let hidden = ws.hidden_rows.contains(&r);
    if truthy(attr_local(&a, "hidden")) != hidden {
        set_attr(&mut a, "hidden", hidden.then(|| "1".into()));
    }
    // The typed row attributes.
    let want = ws.row_meta.get(&r).cloned().unwrap_or_default();
    let was = row_meta_from(&a);
    if want.style != was.style {
        set_attr(
            &mut a,
            "s",
            (want.style != 0).then(|| want.style.to_string()),
        );
    }
    let flags: [(&str, bool, bool); 4] = [
        ("customFormat", want.custom_format, was.custom_format),
        ("collapsed", want.collapsed, was.collapsed),
        ("thickTop", want.thick_top, was.thick_top),
        ("thickBot", want.thick_bot, was.thick_bot),
    ];
    for (name, w, o) in flags {
        if w != o {
            set_attr(&mut a, name, w.then(|| "1".into()));
        }
    }
    if want.outline_level != was.outline_level {
        set_attr(
            &mut a,
            "outlineLevel",
            (want.outline_level != 0).then(|| want.outline_level.to_string()),
        );
    }
    a
}

/// [`RowMeta`] as a row's attributes state it.
fn row_meta_from(a: &[(String, String)]) -> RowMeta {
    RowMeta {
        style: attr_local(a, "s").and_then(|s| s.parse().ok()).unwrap_or(0),
        custom_format: truthy(attr_local(a, "customFormat")),
        outline_level: attr_local(a, "outlineLevel")
            .and_then(|s| s.parse().ok())
            .unwrap_or(0),
        collapsed: truthy(attr_local(a, "collapsed")),
        thick_top: truthy(attr_local(a, "thickTop")),
        thick_bot: truthy(attr_local(a, "thickBot")),
    }
}

/// One column's `<col>` record (min/max unused).
#[derive(Clone, PartialEq)]
struct ColRec {
    width: Option<f64>,
    meta: ColMeta,
}

/// Per-column records from widths + `<col>` attribute ranges.
fn compose_cols(widths: &BTreeMap<u32, f64>, meta: &[ColMeta]) -> BTreeMap<u32, ColRec> {
    let mut out: BTreeMap<u32, ColRec> = BTreeMap::new();
    for m in meta {
        for c in m.min..=m.max.min(sheet_core::MAX_COL) {
            out.insert(
                c,
                ColRec {
                    width: None,
                    meta: ColMeta {
                        min: 0,
                        max: 0,
                        ..m.clone()
                    },
                },
            );
        }
    }
    for (&c, &w) in widths {
        out.entry(c)
            .or_insert_with(|| ColRec {
                width: None,
                meta: ColMeta::default(),
            })
            .width = Some(w);
    }
    out
}

/// A `<cols>` element for `cols` (`None` when there is nothing to say).
fn render_cols(prefix: &str, cols: &BTreeMap<u32, ColRec>) -> Option<String> {
    let mut s = String::new();
    let mut it = cols.iter().peekable();
    while let Some((&c0, rec)) = it.next() {
        let mut c1 = c0;
        while let Some((&n, next)) = it.peek() {
            if n == c1 + 1 && *next == rec {
                c1 = n;
                it.next();
            } else {
                break;
            }
        }
        let m = &rec.meta;
        let mut a: Vec<(String, String)> = vec![
            ("min".into(), (c0 + 1).to_string()),
            ("max".into(), (c1 + 1).to_string()),
        ];
        if let Some(w) = rec.width {
            a.push(("width".into(), fmt_f64(w)));
        }
        if m.style != 0 {
            a.push(("style".into(), m.style.to_string()));
        }
        for (name, on) in [
            ("hidden", m.hidden),
            ("bestFit", m.best_fit),
            ("customWidth", m.custom_width),
            ("phonetic", m.phonetic),
        ] {
            if on {
                a.push((name.into(), "1".into()));
            }
        }
        if m.outline_level != 0 {
            a.push(("outlineLevel".into(), m.outline_level.to_string()));
        }
        if m.collapsed {
            a.push(("collapsed".into(), "1".into()));
        }
        s.push_str(&render_tag(&format!("{prefix}col"), &a, true));
    }
    (!s.is_empty()).then(|| format!("<{prefix}cols>{s}</{prefix}cols>"))
}

/// The `<mergeCells>` refs of an element's bytes, as `(r0, c0, r1, c1)`.
fn merges_of(xml: &[u8], span: &Span) -> Result<Vec<(u32, u32, u32, u32)>, XlsxError> {
    let (kids, _) = children_of(xml, span)?;
    let mut out = Vec::new();
    for k in kids.iter().filter(|k| k.local == "mergeCell") {
        let a = attrs_of(xml, k)?;
        if let Some(r) = attr_local(&a, "ref").as_deref().and_then(parse_range) {
            let n = r.normalized();
            out.push((n.start.row, n.start.col, n.end.row, n.end.col));
        }
    }
    Ok(out)
}

fn a1(r: u32, c: u32) -> String {
    format!("{}{}", col_to_a1(c), r + 1)
}

/// Patch a dirty worksheet part (see the module docs). `None` when the part
/// has no `<sheetData>` to patch (the caller regenerates it).
pub(crate) fn patch_worksheet(input: &PatchInput<'_>) -> Result<Option<Vec<u8>>, XlsxError> {
    let xml = input.original;
    let ws = input
        .model
        .sheet(input.binding.sheet_id)
        .ok_or_else(|| XlsxError::Structure("binding points at missing sheet".into()))?;
    let sid = input.binding.sheet_id;
    let (kids, root_close) = root_children(xml)?;
    let Some(sd) = kids.iter().find(|k| k.local == "sheetData").cloned() else {
        return Ok(None);
    };
    let prefix = crate::splice::prefix_of(&sd.qname).to_string();
    let mut edits: Vec<(usize, usize, Vec<u8>)> = Vec::new();

    // ── <sheetData> ──────────────────────────────────────────────────────
    let (orows, other) = scan_rows(xml, &sd)?;
    let fwd = |r: u32, c: u32| forward(&input.binding.edits, r, c);

    // Shared-formula groups a change touches are written out per cell.
    let mut broken: BTreeSet<u32> = BTreeSet::new();
    for orow in &orows {
        for o in &orow.cells {
            let Some((_, FKind::Shared { si })) = &o.f else {
                continue;
            };
            let stays = fwd(o.row, o.col).is_some_and(|(r, c)| {
                (r, c) == (o.row, o.col)
                    && ws.cell(r, c).is_some()
                    && input.formula_texts.get(&(sid, r, c)) == o.formula.as_ref()
            });
            if !stays {
                broken.insert(*si);
            }
        }
    }

    // Original rows and cells at their (new) addresses.
    let mut orig_rows: BTreeMap<u32, &ORow> = BTreeMap::new();
    let mut orig_cells: HashMap<(u32, u32), &OCell> = HashMap::new();
    for orow in &orows {
        if let Some((r, _)) = fwd(orow.row, 0) {
            orig_rows.insert(r, orow);
        }
        for o in &orow.cells {
            if let Some(at) = fwd(o.row, o.col) {
                orig_cells.insert(at, o);
            }
        }
    }

    // Every row the output holds.
    let mut model_rows: BTreeMap<u32, Vec<(u32, &sheet_core::Cell)>> = BTreeMap::new();
    for (&(r, c), cell) in ws.iter_cells() {
        model_rows.entry(r).or_default().push((c, cell));
    }
    let mut all_rows: BTreeSet<u32> = model_rows.keys().copied().collect();
    all_rows.extend(orig_rows.keys().copied());
    all_rows.extend(ws.row_heights.keys().copied());
    all_rows.extend(ws.hidden_rows.iter().copied());
    all_rows.extend(ws.row_meta.keys().copied());

    let mut body = String::new();
    let mut changed = false;
    let empty_cells: Vec<(u32, &sheet_core::Cell)> = Vec::new();
    for &r in &all_rows {
        let cells = model_rows.get(&r).unwrap_or(&empty_cells);
        let orow = orig_rows.get(&r).copied();
        let cols = cells
            .first()
            .map(|f| (f.0, cells.last().map_or(f.0, |l| l.0)));
        let attrs = row_attrs(orow.map(|o| o.attrs.as_slice()), ws, r, cols);
        let moved = orow.is_some_and(|o| o.row != r);

        // Cells.
        let mut cells_xml = String::new();
        let mut all_same = orow.is_some() && !moved;
        for &(c, cell) in cells {
            let formula = input.formula_texts.get(&(sid, r, c));
            let form = form_of(input, ws, r, c);
            let o = orig_cells.get(&(r, c)).copied();
            let same = o.is_some_and(|o| {
                (o.row, o.col) == (r, c) && cell_unchanged(input, o, cell, formula, form, &broken)
            });
            if same {
                let o = o.expect("checked");
                cells_xml.push_str(&String::from_utf8_lossy(&xml[o.span.start..o.span.end]));
            } else {
                all_same = false;
                render_cell(
                    &mut cells_xml,
                    xml,
                    &prefix,
                    input,
                    o,
                    r,
                    c,
                    cell,
                    formula,
                    form,
                    &broken,
                );
            }
        }
        if let Some(o) = orow {
            // A cell the model no longer holds.
            if o.cells.len() != cells.len() {
                all_same = false;
            }
            if attrs != o.attrs {
                all_same = false;
            }
        }
        if all_same {
            let o = orow.expect("all_same implies an original row");
            body.push_str(&String::from_utf8_lossy(&xml[o.lead.0..o.lead.1]));
            body.push_str(&String::from_utf8_lossy(&xml[o.span.start..o.span.end]));
            continue;
        }
        changed = true;
        // A row with nothing to say is not written.
        let says_something = !cells.is_empty()
            || orow.is_some_and(|o| !o.extra.is_empty())
            || attrs
                .iter()
                .any(|(k, _)| !matches!(k.rsplit(':').next(), Some("r" | "spans")));
        if !says_something {
            continue;
        }
        if let Some(o) = orow {
            body.push_str(&String::from_utf8_lossy(&xml[o.lead.0..o.lead.1]));
        }
        let qname = format!("{prefix}row");
        let mut extra = String::new();
        if let Some(o) = orow {
            for e in &o.extra {
                extra.push_str(&String::from_utf8_lossy(&xml[e.start..e.end]));
            }
        }
        if cells_xml.is_empty() && extra.is_empty() {
            body.push_str(&render_tag(&qname, &attrs, true));
        } else {
            body.push_str(&render_tag(&qname, &attrs, false));
            body.push_str(&cells_xml);
            body.push_str(&extra);
            body.push_str(&format!("</{qname}>"));
        }
    }
    // Rows the edit deleted.
    if orows.iter().any(|o| fwd(o.row, 0).is_none()) {
        changed = true;
    }
    if changed {
        for o in &other {
            body.push_str(&String::from_utf8_lossy(&xml[o.start..o.end]));
        }
        if sd.empty {
            let attrs = attrs_of(xml, &sd)?;
            let mut s = render_tag(&sd.qname, &attrs, false);
            s.push_str(&body);
            s.push_str(&format!("</{}>", sd.qname));
            edits.push((sd.start, sd.end, s.into_bytes()));
        } else {
            let close = sd.end - format!("</{}>", sd.qname).len();
            let tail_start = orows
                .iter()
                .map(|o| o.span.end)
                .chain(other.iter().map(|o| o.end))
                .max()
                .unwrap_or(sd.tag_end);
            let mut s = body.into_bytes();
            s.extend_from_slice(&xml[tail_start..close]);
            edits.push((sd.tag_end, close, s));
        }
    }

    // ── <dimension> ──────────────────────────────────────────────────────
    let want_dim = match ws.used_range() {
        Some(u) if (u.row0, u.col0) == (u.row1, u.col1) => a1(u.row0, u.col0),
        Some(u) => format!("{}:{}", a1(u.row0, u.col0), a1(u.row1, u.col1)),
        None => "A1".into(),
    };
    let dim = kids.iter().find(|k| k.local == "dimension");
    if dim.is_none() && ws.used_range().is_some() {
        // A part without one gets it (Excel writes it), after `<sheetPr>`.
        let at = kids
            .iter()
            .find(|k| k.local != "sheetPr")
            .map_or(root_close, |k| k.start);
        edits.push((
            at,
            at,
            format!(r#"<{prefix}dimension ref="{want_dim}"/>"#).into_bytes(),
        ));
    }
    if let Some(dim) = dim {
        let want = want_dim;
        let mut a = attrs_of(xml, dim)?;
        if attr_local(&a, "ref").as_deref() != Some(want.as_str()) {
            set_attr(&mut a, "ref", Some(want));
            edits.push((
                dim.start,
                dim.tag_end,
                render_tag(&dim.qname, &a, dim.empty).into_bytes(),
            ));
        }
    }

    // ── <cols> ───────────────────────────────────────────────────────────
    let cols_span = kids.iter().find(|k| k.local == "cols");
    let (ow, om) = match cols_span {
        Some(s) => parse_cols(&xml[s.start..s.end])?,
        None => (BTreeMap::new(), Vec::new()),
    };
    let was = compose_cols(&ow, &om);
    let mut want = compose_cols(&ws.col_widths, &ws.col_meta);
    if want != was {
        // A width Paged set is a custom width.
        for (c, rec) in want.iter_mut() {
            if rec.width.is_some() && was.get(c).and_then(|w| w.width) != rec.width {
                rec.meta.custom_width = true;
            }
        }
        let new = render_cols(&prefix, &want).unwrap_or_default();
        match cols_span {
            Some(s) => edits.push((s.start, s.end, new.into_bytes())),
            None => edits.push((sd.start, sd.start, new.into_bytes())),
        }
    }

    // ── <mergeCells> ─────────────────────────────────────────────────────
    let mc_span = kids.iter().find(|k| k.local == "mergeCells");
    let was = match mc_span {
        Some(s) => merges_of(xml, s)?,
        None => Vec::new(),
    };
    let want: Vec<(u32, u32, u32, u32)> = ws
        .merges
        .iter()
        .map(|m| {
            let n = m.normalized();
            (n.start.row, n.start.col, n.end.row, n.end.col)
        })
        .collect();
    if want != was {
        let new = if want.is_empty() {
            String::new()
        } else {
            let mut s = format!(r#"<{prefix}mergeCells count="{}">"#, want.len());
            for (r0, c0, r1, c1) in &want {
                s.push_str(&format!(
                    r#"<{prefix}mergeCell ref="{}:{}"/>"#,
                    a1(*r0, *c0),
                    a1(*r1, *c1)
                ));
            }
            s.push_str(&format!("</{prefix}mergeCells>"));
            s
        };
        match mc_span {
            Some(s) => edits.push((s.start, s.end, new.into_bytes())),
            None => {
                let at = kids
                    .iter()
                    .filter(|k| k.start > sd.start)
                    .find(|k| !BEFORE_MERGE_CELLS.contains(&k.local.as_str()))
                    .map_or(root_close, |k| k.start);
                edits.push((at, at, new.into_bytes()));
            }
        }
    }

    // ── captured children ───────────────────────────────────────────────
    let items = &input.binding.captured.items;
    let known: BTreeSet<(usize, usize)> = items.iter().filter_map(|c| c.span).collect();
    for k in &kids {
        if matches!(
            k.local.as_str(),
            "sheetData" | "dimension" | "cols" | "mergeCells"
        ) {
            continue;
        }
        if !known.contains(&(k.start, k.end)) {
            // A captured child a structural edit removed.
            edits.push((k.start, k.end, Vec::new()));
        }
    }
    for (i, c) in items.iter().enumerate() {
        match c.span {
            Some((s, e)) => {
                if xml.get(s..e) != Some(c.bytes.as_slice()) {
                    edits.push((s, e, c.bytes.clone()));
                }
            }
            None => {
                // Added since: before the next child of its bucket that was
                // read, else in schema position.
                let next = items[i + 1..]
                    .iter()
                    .find(|n| n.anchor == c.anchor)
                    .and_then(|n| n.span);
                let at = match (next, c.anchor) {
                    (Some((s, _)), _) => s,
                    (None, crate::preserve::Anchor::BeforeSheetData) => {
                        cols_span.map_or(sd.start, |s| s.start)
                    }
                    (None, crate::preserve::Anchor::AfterSheetData) => {
                        let local = captured_local(&c.bytes);
                        kids.iter()
                            .find(|k| k.local == "extLst" && local != "extLst")
                            .map_or(root_close, |k| k.start)
                    }
                };
                edits.push((at, at, c.bytes.clone()));
            }
        }
    }

    if edits.is_empty() {
        return Ok(Some(xml.to_vec()));
    }
    // Apply front to back; insertions at one offset keep their order.
    edits.sort_by_key(|e| (e.0, e.1));
    let mut out = Vec::with_capacity(xml.len() + 256);
    let mut pos = 0;
    for (s, e, bytes) in edits {
        if s < pos {
            return Err(XlsxError::Structure("overlapping worksheet patches".into()));
        }
        out.extend_from_slice(&xml[pos..s]);
        out.extend_from_slice(&bytes);
        pos = e;
    }
    out.extend_from_slice(&xml[pos..]);
    Ok(Some(out))
}
