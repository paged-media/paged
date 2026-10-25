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

//! # The Data Merge planner (campaign Wave 5, `docs/design/oracles.md` §2)
//!
//! InDesign Data Merge, as a pure function: a TEMPLATE (the frames of one
//! page, text frames carrying `<<field>>` placeholders and image frames
//! carrying an `@field`), a record set in SOURCE order and the merge options
//! go in; out comes where every record lands (page, grid row and column, the
//! offset of its copy of the template) and what each of its frames holds.
//! The host writer (`data-bundle/src/merge.ts`) turns the plan into
//! mutations; nothing here knows the host.
//!
//! The layout is the closed-form rule that reproduces all eight InDesign
//! recordings within ±0.5 pt (`data-conformance/tests/it/oracle.rs`):
//!
//! - **Single Record** (DM-1): every record gets its own page, its frames at
//!   the template's own position.
//! - **Multiple Records** (DM-3): the record cell is the union of the
//!   template's merge frames, `h × w`. Within the margin box `H × W`,
//!   rows = ⌊(H + row spacing) / (h + row spacing)⌋ and
//!   columns = ⌊(W + column spacing) / (w + column spacing)⌋; slot *s* of a page
//!   sits at the margin origin + (column·(w + column spacing),
//!   row·(h + row spacing)).
//! - **Arrangement** (DM-4): rows first fills a row left to right, columns
//!   first fills a column top to bottom.
//! - **Order** (DM-2): record *k* is the *k*-th row of the record set as
//!   delivered; nothing is re-sorted here. It goes on page ⌊k / (rows·cols)⌋.
//! - **Field text** is inserted verbatim (Data Merge does not reformat).
//!   With Remove Blank Lines (DM-5) a line is dropped only when it holds
//!   nothing but fields and every one of them is empty.
//! - **Image fields** (DM-6): the frame's field names a column whose value is
//!   the image reference; an empty value leaves the frame empty.
//!
//! Overset (DM-7) needs real text measurement. The writer asks this module
//! for the words each template frame's texts use ([`merge_words`]), measures
//! them once against the host's fonts, and hands the widths back to
//! [`merge_overset`], which wraps every merged text and compares its lines ×
//! leading with the frame.

use std::collections::{BTreeSet, HashMap};

use serde::{Deserialize, Serialize};

use data_core::{RecordSet, Value};

/// A rectangle in page coordinates (pt): `[top, left, bottom, right]`, the
/// same order as InDesign's `geometricBounds` and the host's frame bounds.
pub type Bounds = [f64; 4];

/// How the records of a merge share pages.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum RecordsPerPage {
    /// One record per page, at the template position.
    Single,
    /// As many records per page as the margin box holds.
    #[serde(rename_all = "camelCase")]
    Multiple {
        #[serde(default)]
        arrange: MergeArrange,
        #[serde(default)]
        row_spacing_pt: f64,
        #[serde(default)]
        column_spacing_pt: f64,
    },
}

/// The fill order of a Multiple Records page.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MergeArrange {
    /// Left to right, then the next row (InDesign's default).
    #[default]
    Rows,
    /// Top to bottom, then the next column.
    Columns,
}

/// What a template frame contributes to each record.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum MergeFrameContent {
    /// A text frame; `text` is its story, `<<field>>` placeholders included,
    /// paragraphs (and forced line breaks) separated by `\n`.
    Text { text: String },
    /// An image frame filled from `field` (with or without its leading `@`).
    Image { field: String },
}

/// One frame of the record template.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeTemplateFrame {
    /// The host's id for the template frame (carried through, never read).
    pub id: String,
    pub bounds: Bounds,
    pub content: MergeFrameContent,
}

/// Everything the planner needs besides the records.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeSpec {
    /// The template page's margin box.
    pub margin_box: Bounds,
    pub frames: Vec<MergeTemplateFrame>,
    pub records_per_page: RecordsPerPage,
    /// Remove Blank Lines for Empty Fields.
    #[serde(default)]
    pub remove_blank_lines: bool,
}

/// One frame of one merged record.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergedFrame {
    /// Index into [`MergeSpec::frames`].
    pub template: usize,
    pub bounds: Bounds,
    /// The merged text (text frames).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// The image reference (image frames whose field is not empty).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
}

/// One merged record.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergedRecord {
    /// The record's row in the record set (source order).
    pub record: usize,
    /// The output page (0-based).
    pub page: usize,
    pub row: usize,
    pub column: usize,
    pub frames: Vec<MergedFrame>,
}

/// The whole merge.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergePlan {
    /// Records per column and columns per page (1 × 1 for Single Record).
    pub rows: usize,
    pub columns: usize,
    pub per_page: usize,
    pub page_count: usize,
    pub records: Vec<MergedRecord>,
    /// Every placeholder field the template names, in first-use order.
    pub fields: Vec<String>,
    /// Fields the record set has no column for (they merge as empty).
    pub missing_fields: Vec<String>,
    /// Human-readable notes (a cell larger than the margin box, …).
    pub diagnostics: Vec<String>,
}

/// The placeholder field names in a template text, in order of use
/// (repeats kept once).
pub fn placeholder_fields(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for (_, name, _) in placeholders(text) {
        if !out.iter().any(|f| f == name) {
            out.push(name.to_string());
        }
    }
    out
}

/// One Data Merge placeholder of a text: where it is (byte offsets, the
/// host's text offsets) and the field it reads. `<<price>>` reads `price`;
/// `<<@photo>>` is an image placeholder of `photo` (`image`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlaceholderSpan {
    pub start: usize,
    pub end: usize,
    pub field: String,
    pub image: bool,
}

/// Every placeholder of `text` that names a field (a `<<name>>` that is not
/// a field reference stays literal text, as [`template_lines`] keeps it), in
/// order. Filling a design with one record replaces each span by the
/// record's field.
pub fn placeholder_spans(text: &str) -> Vec<PlaceholderSpan> {
    placeholders(text)
        .into_iter()
        .filter_map(|(start, name, end)| {
            let (field, image) = match name.strip_prefix('@') {
                Some(rest) => (rest, true),
                None => (name, false),
            };
            is_field_ident(field).then(|| PlaceholderSpan {
                start,
                end,
                field: field.to_string(),
                image,
            })
        })
        .collect()
}

/// `(start, name, end)` byte spans of every `<<name>>` in `text`.
fn placeholders(text: &str) -> Vec<(usize, &str, usize)> {
    let mut out = Vec::new();
    let mut at = 0;
    while let Some(start) = text[at..].find("<<").map(|i| i + at) {
        let Some(close) = text[start + 2..].find(">>").map(|i| i + start + 2) else {
            break;
        };
        let name = &text[start + 2..close];
        // A `<<` inside the name means the first `<<` was literal text.
        if let Some(inner) = name.rfind("<<") {
            at = start + 2 + inner;
            continue;
        }
        out.push((start, name, close + 2));
        at = close + 2;
    }
    out
}

/// One line of a record template read off a frame's text (a record flow's
/// "catalog cell"): the static `label` printed before the value, and the
/// binding-language `expr` evaluated per record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TemplateLine {
    pub label: String,
    pub expr: String,
}

/// What [`template_lines`] read: one line per text line, and the
/// placeholders it could not turn into a field reference.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct TemplateLines {
    pub lines: Vec<TemplateLine>,
    /// `<<name>>`s whose name is not a field reference of the binding language
    /// (a space, a leading digit, a keyword): kept as literal text.
    pub unreferenced: Vec<String>,
}

/// Read a record template from frame text written as for Data Merge: each
/// line is one template line, and a `<<field>>` reads the record's `field`.
/// `Price: <<price>>` becomes the label `Price: ` and the expression `price`;
/// a line with more than one field, or text after its field, becomes one `&`
/// concatenation (`<<w>> × <<h>> mm` → `w & " × " & h & " mm"`); a line with
/// no field is a label alone. Empty lines are dropped.
pub fn template_lines(text: &str) -> TemplateLines {
    let mut out = TemplateLines::default();
    for raw in text.split(['\n', '\r', '\u{2029}']) {
        if raw.trim().is_empty() {
            continue;
        }
        let mut spans: Vec<(usize, &str, usize)> = Vec::new();
        for span in placeholders(raw) {
            if is_field_ident(span.1) {
                spans.push(span);
            } else if !out.unreferenced.iter().any(|u| u == span.1) {
                out.unreferenced.push(span.1.to_string());
            }
        }
        let line = match spans.as_slice() {
            [] => TemplateLine {
                label: raw.to_string(),
                expr: "\"\"".to_string(),
            },
            [(start, name, end)] if *end == raw.len() => TemplateLine {
                label: raw[..*start].to_string(),
                expr: (*name).to_string(),
            },
            _ => {
                let mut parts: Vec<String> = Vec::new();
                let mut at = 0;
                for (start, name, end) in &spans {
                    if *start > at {
                        parts.push(string_literal(&raw[at..*start]));
                    }
                    parts.push((*name).to_string());
                    at = *end;
                }
                if at < raw.len() {
                    parts.push(string_literal(&raw[at..]));
                }
                TemplateLine {
                    label: String::new(),
                    expr: parts.join(" & "),
                }
            }
        };
        out.lines.push(line);
    }
    out
}

/// A name the binding language reads as a field: a letter or `_`, then
/// letters, digits and `_`, and not a keyword.
fn is_field_ident(name: &str) -> bool {
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (first.is_alphabetic() || first == '_')
        && chars.all(|c| c.is_alphanumeric() || c == '_')
        && !matches!(
            name.to_ascii_uppercase().as_str(),
            "TRUE" | "FALSE" | "NULL"
        )
}

/// A binding-language string literal (a doubled quote escapes a quote).
fn string_literal(text: &str) -> String {
    format!("\"{}\"", text.replace('"', "\"\""))
}

/// Merge one template text: every `<<field>>` becomes `value(field)`
/// verbatim (`None` merges as empty). With `remove_blank_lines`, a line whose
/// only content is fields that are all empty disappears (Data Merge's Remove
/// Blank Lines for Empty Fields: a label beside an empty field keeps its line).
pub fn merge_text(
    template: &str,
    value: &dyn Fn(&str) -> Option<String>,
    remove_blank_lines: bool,
) -> String {
    let mut lines = Vec::new();
    for line in template.split('\n') {
        let spans = placeholders(line);
        let mut out = String::with_capacity(line.len());
        let mut at = 0;
        let mut only_fields = !spans.is_empty();
        let mut all_empty = true;
        for (start, name, end) in &spans {
            if !line[at..*start].trim().is_empty() {
                only_fields = false;
            }
            out.push_str(&line[at..*start]);
            let v = value(name).unwrap_or_default();
            if !v.is_empty() {
                all_empty = false;
            }
            out.push_str(&v);
            at = *end;
        }
        if !line[at..].trim().is_empty() {
            only_fields = false;
        }
        out.push_str(&line[at..]);
        if remove_blank_lines && only_fields && all_empty {
            continue;
        }
        lines.push(out);
    }
    lines.join("\n")
}

/// The column a Data Merge field reads: the exact name, else the name with
/// (or without) the image-field `@`, else a case-insensitive match.
fn column_of(records: &RecordSet, field: &str) -> Option<usize> {
    let bare = field.trim_start_matches('@');
    let schema = &records.schema;
    schema
        .index_of(field)
        .or_else(|| schema.index_of(bare))
        .or_else(|| schema.index_of(&format!("@{bare}")))
        .or_else(|| {
            schema
                .fields
                .iter()
                .position(|f| f.name.trim_start_matches('@').eq_ignore_ascii_case(bare))
        })
}

/// A cell as Data Merge prints it: text verbatim, null as nothing.
fn cell_text(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(Value::Text(t)) => t.to_string(),
        Some(other) => other.as_display(),
    }
}

/// The union of the template's frames: the record cell.
fn cell_of(frames: &[MergeTemplateFrame]) -> Bounds {
    frames.iter().fold(
        [
            f64::INFINITY,
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::NEG_INFINITY,
        ],
        |a, f| {
            [
                a[0].min(f.bounds[0]),
                a[1].min(f.bounds[1]),
                a[2].max(f.bounds[2]),
                a[3].max(f.bounds[3]),
            ]
        },
    )
}

/// `(rows, columns)` of the record grid, and a note when the cell does not
/// fit the margin box at all (the grid is then clamped to one slot).
pub fn merge_grid(spec: &MergeSpec) -> (usize, usize, Option<String>) {
    let RecordsPerPage::Multiple {
        row_spacing_pt,
        column_spacing_pt,
        ..
    } = spec.records_per_page
    else {
        return (1, 1, None);
    };
    if spec.frames.is_empty() {
        return (1, 1, None);
    }
    let cell = cell_of(&spec.frames);
    let (h, w) = (cell[2] - cell[0], cell[3] - cell[1]);
    let mb = spec.margin_box;
    let (big_h, big_w) = (mb[2] - mb[0], mb[3] - mb[1]);
    // A hair of tolerance: a cell that fits exactly must not lose a row to
    // floating-point noise.
    const EPS: f64 = 1e-6;
    let rows = ((big_h + row_spacing_pt + EPS) / (h + row_spacing_pt)).floor();
    let cols = ((big_w + column_spacing_pt + EPS) / (w + column_spacing_pt)).floor();
    let note = (rows < 1.0 || cols < 1.0).then(|| {
        format!(
            "the record ({w:.1} × {h:.1} pt) is larger than the margin box ({big_w:.1} × {big_h:.1} pt); one record per page"
        )
    });
    (rows.max(1.0) as usize, cols.max(1.0) as usize, note)
}

/// Plan a Data Merge of `records` (in their delivered order) through `spec`.
pub fn plan_merge(spec: &MergeSpec, records: &RecordSet) -> MergePlan {
    let (rows, columns, note) = merge_grid(spec);
    let per_page = rows * columns;
    let mut diagnostics: Vec<String> = note.into_iter().collect();

    // Every field the template names, and the column each reads.
    let mut fields: Vec<String> = Vec::new();
    for f in &spec.frames {
        let names = match &f.content {
            MergeFrameContent::Text { text } => placeholder_fields(text),
            MergeFrameContent::Image { field } => vec![field.clone()],
        };
        for n in names {
            if !fields.contains(&n) {
                fields.push(n);
            }
        }
    }
    let columns_of: Vec<Option<usize>> = fields.iter().map(|f| column_of(records, f)).collect();
    let missing_fields: Vec<String> = fields
        .iter()
        .zip(&columns_of)
        .filter(|(_, c)| c.is_none())
        .map(|(f, _)| f.clone())
        .collect();
    if !missing_fields.is_empty() {
        diagnostics.push(format!(
            "no column for field(s) {} — merged as empty",
            missing_fields.join(", ")
        ));
    }

    let cell = cell_of(&spec.frames);
    let (pitch_y, pitch_x, origin) = match spec.records_per_page {
        RecordsPerPage::Single => (0.0, 0.0, [cell[0], cell[1]]),
        RecordsPerPage::Multiple {
            row_spacing_pt,
            column_spacing_pt,
            ..
        } => (
            cell[2] - cell[0] + row_spacing_pt,
            cell[3] - cell[1] + column_spacing_pt,
            [spec.margin_box[0], spec.margin_box[1]],
        ),
    };
    let arrange = match spec.records_per_page {
        RecordsPerPage::Multiple { arrange, .. } => arrange,
        RecordsPerPage::Single => MergeArrange::Rows,
    };

    let mut out = Vec::with_capacity(records.row_count);
    for k in 0..records.row_count {
        let (page, slot) = (k / per_page, k % per_page);
        let (row, column) = match arrange {
            MergeArrange::Rows => (slot / columns, slot % columns),
            MergeArrange::Columns => (slot % rows, slot / rows),
        };
        let dy = origin[0] + row as f64 * pitch_y - cell[0];
        let dx = origin[1] + column as f64 * pitch_x - cell[1];
        let value = |name: &str| -> Option<String> {
            let i = fields.iter().position(|f| f == name)?;
            columns_of[i].map(|c| cell_text(records.value(k, c)))
        };
        let frames = spec
            .frames
            .iter()
            .enumerate()
            .map(|(i, f)| {
                let b = f.bounds;
                let bounds = [b[0] + dy, b[1] + dx, b[2] + dy, b[3] + dx];
                match &f.content {
                    MergeFrameContent::Text { text } => MergedFrame {
                        template: i,
                        bounds,
                        text: Some(merge_text(text, &value, spec.remove_blank_lines)),
                        image: None,
                    },
                    MergeFrameContent::Image { field } => MergedFrame {
                        template: i,
                        bounds,
                        text: None,
                        image: value(field).filter(|v| !v.is_empty()),
                    },
                }
            })
            .collect();
        out.push(MergedRecord {
            record: k,
            page,
            row,
            column,
            frames,
        });
    }
    MergePlan {
        rows,
        columns,
        per_page,
        page_count: records.row_count.div_ceil(per_page),
        records: out,
        fields,
        missing_fields,
        diagnostics,
    }
}

// ── overset (DM-7) ──────────────────────────────────────────────────────────

/// The distinct words of every merged text, per template frame (index =
/// [`MergeSpec::frames`] index; image frames get none). A word is a run of
/// characters between spaces within a line; the space itself is listed too,
/// since the wrap needs its width.
pub fn merge_words(plan: &MergePlan, frames: usize) -> Vec<Vec<String>> {
    let mut sets: Vec<BTreeSet<String>> = vec![BTreeSet::new(); frames];
    for r in &plan.records {
        for f in &r.frames {
            let (Some(text), Some(set)) = (&f.text, sets.get_mut(f.template)) else {
                continue;
            };
            set.extend(text_words(text));
        }
    }
    sets.into_iter().map(|s| s.into_iter().collect()).collect()
}

/// The distinct words of one text, as [`count_lines`] measures them: a run
/// of characters between spaces within a line, and the space itself (the
/// wrap needs its width); none for an empty text.
pub fn text_words(text: &str) -> Vec<String> {
    if text.is_empty() {
        return Vec::new();
    }
    let mut set = BTreeSet::new();
    set.insert(" ".to_string());
    for line in text.split('\n') {
        for w in line.split(' ').filter(|w| !w.is_empty()) {
            set.insert(w.to_string());
        }
    }
    set.into_iter().collect()
}

/// Is `text` overset in a text frame `width` × `height` (pt) at `metrics`?
/// Its wrapped lines × leading exceed the height by more than half a point
/// (DM-7's rule; data ADR 564 asks it of any placed text). An empty text
/// never is.
pub fn text_overset(text: &str, width: f64, height: f64, metrics: &FrameMetrics) -> bool {
    !text.is_empty()
        && count_lines(text, width, &metrics.advances) as f64 * metrics.leading_pt > height + 0.5
}

/// The measured font of one template frame: its leading and the advance of
/// every word [`merge_words`] listed for it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameMetrics {
    pub leading_pt: f64,
    #[serde(default)]
    pub advances: HashMap<String, f64>,
}

/// How many lines `text` takes in a column `width` wide: greedy word wrap
/// per line, an empty line is one line, and a word wider than the column
/// takes the lines its width needs. Unmeasured words count as zero width.
pub fn count_lines(text: &str, width: f64, advances: &HashMap<String, f64>) -> usize {
    let adv = |w: &str| advances.get(w).copied().unwrap_or(0.0);
    let space = adv(" ");
    let span = |a: f64| -> usize {
        if width <= 0.0 {
            1
        } else {
            ((a / width).ceil() as usize).max(1)
        }
    };
    let mut lines = 0;
    for line in text.split('\n') {
        let mut used: Option<f64> = None;
        for w in line.split(' ').filter(|w| !w.is_empty()) {
            let a = adv(w);
            match used {
                Some(u) if u + space + a <= width + 1e-6 => used = Some(u + space + a),
                _ => {
                    lines += span(a);
                    used = Some(if a > width && width > 0.0 {
                        a % width
                    } else {
                        a
                    });
                }
            }
        }
        if used.is_none() {
            lines += 1;
        }
    }
    lines
}

/// Per record, per frame: is the merged text overset? A text frame is
/// overset when its wrapped lines × leading exceed the frame height by more
/// than half a point (Data Merge never grows a frame). Image frames never are.
pub fn merge_overset(plan: &MergePlan, metrics: &[FrameMetrics]) -> Vec<Vec<bool>> {
    plan.records
        .iter()
        .map(|r| {
            r.frames
                .iter()
                .map(|f| match (&f.text, metrics.get(f.template)) {
                    (Some(text), Some(m)) => text_overset(
                        text,
                        f.bounds[3] - f.bounds[1],
                        f.bounds[2] - f.bounds[0],
                        m,
                    ),
                    _ => false,
                })
                .collect()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use data_core::{FieldType, Schema};

    fn records(header: &[&str], rows: &[&[&str]]) -> RecordSet {
        let schema = Schema::from_fields(header.iter().map(|h| (h.to_string(), FieldType::Text)));
        let columns = (0..header.len())
            .map(|c| {
                rows.iter()
                    .map(|r| {
                        if r[c].is_empty() {
                            Value::Null
                        } else {
                            Value::text(r[c])
                        }
                    })
                    .collect()
            })
            .collect();
        RecordSet::new(schema, columns).unwrap()
    }

    fn text_frame(bounds: Bounds, text: &str) -> MergeTemplateFrame {
        MergeTemplateFrame {
            id: "t".into(),
            bounds,
            content: MergeFrameContent::Text { text: text.into() },
        }
    }

    const LETTER_MARGINS: Bounds = [36.0, 36.0, 756.0, 576.0];

    #[test]
    #[allow(non_snake_case)] // the `__feat__<id>` suffix links the test to its cockpit feature
    fn data_lower_text_overset_wraps_and_compares__feat__data_issues() {
        assert_eq!(text_words("a bb\na"), [" ", "a", "bb"]);
        assert!(text_words("").is_empty());
        let m = FrameMetrics {
            leading_pt: 12.0,
            advances: [("a", 10.0), (" ", 5.0)]
                .into_iter()
                .map(|(w, a)| (w.to_string(), a))
                .collect(),
        };
        // Two words a line at 25 pt: four words take two lines, 24 pt.
        assert!(!text_overset("a a a a", 25.0, 24.0, &m));
        assert!(text_overset("a a a a", 25.0, 20.0, &m));
        assert!(!text_overset("", 25.0, 0.0, &m));
    }

    #[test]
    #[allow(non_snake_case)] // the `__feat__<id>` suffix links the test to its cockpit feature
    fn data_lower_record_templates_lines_from_frame_text__feat__data_lower_record_templates() {
        let t = template_lines(
            "<<name>>\nPrice: <<price>>\n\n<<w>> × <<h>> mm\nIn stock\n<<a b>> <<sku>>",
        );
        let pairs: Vec<(&str, &str)> = t
            .lines
            .iter()
            .map(|l| (l.label.as_str(), l.expr.as_str()))
            .collect();
        assert_eq!(
            pairs,
            [
                ("", "name"),
                ("Price: ", "price"),
                ("", "w & \" × \" & h & \" mm\""),
                ("In stock", "\"\""),
                ("<<a b>> ", "sku"),
            ]
        );
        assert_eq!(t.unreferenced, ["a b"]);
        assert_eq!(
            template_lines("<<x>> said \"hi\"").lines[0].expr,
            "x & \" said \"\"hi\"\"\""
        );
        assert_eq!(template_lines("<<true>>").unreferenced, ["true"]);
    }

    #[test]
    #[allow(non_snake_case)] // the `__feat__<id>` suffix links the test to its cockpit feature
    fn data_lower_placeholder_spans_are_byte_spans_of_fields__feat__data_lower_merge_writer() {
        let text = "Größe <<size>>\n<<@photo>> <<a b>> <<sku>><<true>>";
        let spans = placeholder_spans(text);
        let got: Vec<(&str, bool, &str)> = spans
            .iter()
            .map(|s| (s.field.as_str(), s.image, &text[s.start..s.end]))
            .collect();
        assert_eq!(
            got,
            [
                ("size", false, "<<size>>"),
                ("photo", true, "<<@photo>>"),
                ("sku", false, "<<sku>>"),
            ]
        );
        // Byte offsets: the `ö` and `ß` are two bytes each.
        assert_eq!(spans[0].start, 8);
        assert!(placeholder_spans("no fields <<>> here").is_empty());
    }

    #[test]
    fn data_lower_merge_text_is_verbatim_and_drops_only_field_only_blank_lines() {
        let v = |n: &str| match n {
            "name" => Some("Beta".to_string()),
            "price" => Some("1.00".to_string()),
            _ => Some(String::new()),
        };
        let t = "<<name>>\n<<subtitle>>\nPrice: <<price>>\nNote: <<subtitle>>";
        assert_eq!(merge_text(t, &v, false), "Beta\n\nPrice: 1.00\nNote: ");
        assert_eq!(merge_text(t, &v, true), "Beta\nPrice: 1.00\nNote: ");
        // Two fields on one line: dropped only when BOTH are empty.
        assert_eq!(merge_text("<<a>> <<name>>", &v, true), " Beta");
        assert_eq!(merge_text("<<a>> <<b>>", &v, true), "");
        // A literal `<<` that never closes stays as text.
        assert_eq!(merge_text("a << b <<name>>", &v, false), "a << b Beta");
    }

    #[test]
    fn data_lower_merge_single_record_is_one_page_per_record_in_source_order() {
        let rs = records(&["name"], &[&["Zed"], &["Alpha"], &["Mid"]]);
        let spec = MergeSpec {
            margin_box: LETTER_MARGINS,
            frames: vec![text_frame([36.0, 36.0, 136.0, 336.0], "<<name>>")],
            records_per_page: RecordsPerPage::Single,
            remove_blank_lines: false,
        };
        let plan = plan_merge(&spec, &rs);
        assert_eq!((plan.rows, plan.columns, plan.page_count), (1, 1, 3));
        let got: Vec<(usize, &str)> = plan
            .records
            .iter()
            .map(|r| (r.page, r.frames[0].text.as_deref().unwrap()))
            .collect();
        assert_eq!(got, vec![(0, "Zed"), (1, "Alpha"), (2, "Mid")]);
        assert!(plan
            .records
            .iter()
            .all(|r| r.frames[0].bounds == [36.0, 36.0, 136.0, 336.0]));
    }

    #[test]
    fn data_lower_merge_multiple_records_grid_rows_and_columns_first() {
        let rs = records(&["n"], &(0..7).map(|_| &["x"][..]).collect::<Vec<_>>());
        let mut spec = MergeSpec {
            margin_box: LETTER_MARGINS,
            frames: vec![text_frame([36.0, 36.0, 96.0, 276.0], "<<n>>")],
            records_per_page: RecordsPerPage::Multiple {
                arrange: MergeArrange::Rows,
                row_spacing_pt: 12.0,
                column_spacing_pt: 18.0,
            },
            remove_blank_lines: false,
        };
        let plan = plan_merge(&spec, &rs);
        // (720 + 12) / 72 = 10 rows; (540 + 18) / 258 = 2 columns.
        assert_eq!(
            (plan.rows, plan.columns, plan.per_page, plan.page_count),
            (10, 2, 20, 1)
        );
        let r2 = &plan.records[2];
        assert_eq!((r2.row, r2.column), (1, 0));
        assert_eq!(r2.frames[0].bounds, [108.0, 36.0, 168.0, 276.0]);
        assert_eq!(plan.records[1].frames[0].bounds, [36.0, 294.0, 96.0, 534.0]);

        spec.records_per_page = RecordsPerPage::Multiple {
            arrange: MergeArrange::Columns,
            row_spacing_pt: 12.0,
            column_spacing_pt: 18.0,
        };
        let plan = plan_merge(&spec, &rs);
        assert_eq!((plan.records[1].row, plan.records[1].column), (1, 0));
    }

    #[test]
    fn data_lower_merge_image_fields_and_missing_columns() {
        let rs = records(&["name", "@photo"], &[&["Red", "red.png"], &["None", ""]]);
        let spec = MergeSpec {
            margin_box: LETTER_MARGINS,
            frames: vec![
                text_frame([36.0, 36.0, 60.0, 236.0], "<<name>> <<sku>>"),
                MergeTemplateFrame {
                    id: "img".into(),
                    bounds: [72.0, 36.0, 172.0, 186.0],
                    content: MergeFrameContent::Image {
                        field: "photo".into(),
                    },
                },
            ],
            records_per_page: RecordsPerPage::Single,
            remove_blank_lines: false,
        };
        let plan = plan_merge(&spec, &rs);
        assert_eq!(plan.fields, vec!["name", "sku", "photo"]);
        assert_eq!(plan.missing_fields, vec!["sku"]);
        assert_eq!(plan.records[0].frames[1].image.as_deref(), Some("red.png"));
        assert_eq!(plan.records[1].frames[1].image, None);
        assert_eq!(plan.records[0].frames[0].text.as_deref(), Some("Red "));
    }

    #[test]
    fn data_lower_merge_cell_larger_than_the_page_is_one_per_page_with_a_note() {
        let rs = records(&["n"], &[&["a"], &["b"]]);
        let spec = MergeSpec {
            margin_box: [36.0, 36.0, 100.0, 100.0],
            frames: vec![text_frame([36.0, 36.0, 236.0, 236.0], "<<n>>")],
            records_per_page: RecordsPerPage::Multiple {
                arrange: MergeArrange::Rows,
                row_spacing_pt: 0.0,
                column_spacing_pt: 0.0,
            },
            remove_blank_lines: false,
        };
        let plan = plan_merge(&spec, &rs);
        assert_eq!((plan.per_page, plan.page_count), (1, 2));
        assert_eq!(plan.diagnostics.len(), 1);
    }

    #[test]
    fn data_lower_merge_spec_wire_shape_is_camel_case() {
        let spec: MergeSpec = serde_json::from_str(
            r#"{"marginBox":[36,36,756,576],"frames":[{"id":"f","bounds":[36,36,96,276],
                "content":{"kind":"text","text":"<<n>>"}}],
                "recordsPerPage":{"mode":"multiple","arrange":"columns","rowSpacingPt":6},
                "removeBlankLines":true}"#,
        )
        .unwrap();
        assert_eq!(
            spec.records_per_page,
            RecordsPerPage::Multiple {
                arrange: MergeArrange::Columns,
                row_spacing_pt: 6.0,
                column_spacing_pt: 0.0
            }
        );
    }

    #[test]
    fn data_lower_merge_overset_wraps_measured_words_against_the_frame() {
        let rs = records(
            &["name", "d"],
            &[
                &["Short", "Fits easily."],
                &["Long", "aaaa bbbb cccc dddd eeee ffff"],
            ],
        );
        let spec = MergeSpec {
            margin_box: LETTER_MARGINS,
            // 36 pt tall at 12 pt leading: three lines fit.
            frames: vec![text_frame([36.0, 36.0, 72.0, 86.0], "<<name>>\n<<d>>")],
            records_per_page: RecordsPerPage::Single,
            remove_blank_lines: false,
        };
        let plan = plan_merge(&spec, &rs);
        let words = merge_words(&plan, 1);
        assert!(words[0].contains(&" ".to_string()) && words[0].contains(&"Fits".to_string()));
        // Every word 20 pt, a space 5 pt: a 50 pt column holds two words.
        let advances = words[0]
            .iter()
            .map(|w| (w.clone(), if w == " " { 5.0 } else { 20.0 }))
            .collect();
        let m = FrameMetrics {
            leading_pt: 12.0,
            advances,
        };
        assert_eq!(count_lines("Fits easily.", 50.0, &m.advances), 1);
        assert_eq!(
            count_lines("aaaa bbbb cccc dddd eeee ffff", 50.0, &m.advances),
            3
        );
        assert_eq!(count_lines("a\n\nb", 50.0, &m.advances), 3);
        let over = merge_overset(&plan, &[m]);
        // Short: 2 lines = 24 pt. Long: 1 + 3 lines = 48 pt > 36 pt.
        assert_eq!(over, vec![vec![false], vec![true]]);
    }

    #[test]
    fn data_lower_merge_a_word_wider_than_the_column_takes_its_lines() {
        let advances: HashMap<String, f64> =
            [("w".to_string(), 120.0), (" ".to_string(), 5.0)].into();
        assert_eq!(count_lines("w", 50.0, &advances), 3);
        assert_eq!(count_lines("w w", 50.0, &advances), 6);
    }
}
