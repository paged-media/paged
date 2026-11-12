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

//! Doc ADR 600, amendment 2026-11-12b: the pour's direct formatting, decided
//! here.
//!
//! The lowering names a synthesized `docx-auto-*` style for every distinct
//! set of Word direct formatting. The native body and the placement batch
//! write such a look as the Word style it stands on plus direct properties
//! ([`crate::body::paragraph_plan`]). The TypeScript pour, which still opens
//! a document the native builder does not take whole, writes the same looks:
//! [`annotate`] puts the plan into the IR it is handed (`direct` on every
//! paragraph, break part, run and table paragraph, `before_direct` on a
//! tracked change's look before, and the styles still to mint), so the pour
//! applies what it is told and holds no rule of its own.
//!
//! Where the direct form cannot be written the plan keeps the synthesized
//! style, as the native body does: a paragraph whose paragraph style's
//! character properties have no run to carry them or would override a run's
//! Word character style, a paragraph a break splits into parts with other
//! character properties, a tracked change's paragraph look with character
//! properties, and a look whose synthesized style is missing from the
//! catalogue.

use std::collections::{BTreeSet, HashMap};

use docx_lower::ir::{
    LoweredBlock, LoweredDirect, LoweredDoc, LoweredItemKind, LoweredParagraph, LoweredTable,
    StyleProp,
};

use crate::body::{is_synthesized, paragraph_plan_with, split_look};

fn look(style: Option<&str>, props: &[&StyleProp]) -> LoweredDirect {
    LoweredDirect {
        style: style.map(str::to_owned),
        props: props.iter().map(|p| (*p).clone()).collect(),
    }
}

fn is_char(p: &StyleProp) -> bool {
    p.path.starts_with("character")
}

/// The plan of one paragraph, written onto it, its runs, its break parts
/// and its tracked changes' looks before; then the text boxes it holds.
fn annotate_paragraph(cat: &LoweredDoc, p: &mut LoweredParagraph) {
    // A break's part takes its own paragraph style; its character
    // properties are the runs' only while every part has the first's, else
    // the paragraph and its parts keep their synthesized styles (the native
    // body defers those; the pour keeps them).
    let mut keep = false;
    let first_chars: Option<Vec<&StyleProp>> = split_look(cat, p.para_style_id.as_deref())
        .map(|(_, props)| props.into_iter().filter(|x| is_char(x)).collect());
    let mut parts: Vec<Option<(Option<&str>, Vec<&StyleProp>)>> = Vec::new();
    for seg in &p.segments {
        let split = split_look(cat, seg.para_style_id.as_deref());
        let chars: Option<Vec<&StyleProp>> = split
            .as_ref()
            .map(|(_, props)| props.iter().copied().filter(|x| is_char(x)).collect());
        if split.is_none() || first_chars.is_none() || chars != first_chars {
            keep = true;
        }
        parts.push(split);
    }
    let plan = paragraph_plan_with(cat, p, keep);
    let para = look(plan.style, &plan.props);
    let runs: Vec<Option<LoweredDirect>> = plan
        .runs
        .iter()
        .map(|r| r.as_ref().map(|(style, props)| look(*style, props)))
        .collect();
    let kept = plan.kept || keep;
    let segs: Vec<LoweredDirect> = p
        .segments
        .iter()
        .zip(&parts)
        .map(|(seg, split)| match split {
            Some((base, props)) if !kept => {
                let props: Vec<&StyleProp> =
                    props.iter().copied().filter(|x| !is_char(x)).collect();
                look(*base, &props)
            }
            _ => look(seg.para_style_id.as_deref(), &[]),
        })
        .collect();
    let befores: Vec<Option<LoweredDirect>> = p
        .runs
        .iter()
        .map(|r| {
            let f = r.format_change.as_ref()?;
            let (base, props) = split_look(cat, f.before_char_style_id.as_deref())?;
            Some(look(base, &props))
        })
        .collect();
    let para_before = p.props_change.as_ref().and_then(|pc| {
        let (base, props) = split_look(cat, pc.before_para_style_id.as_deref())?;
        // A paragraph's look has no character properties of its own.
        (!props.iter().any(|x| is_char(x))).then(|| look(base, &props))
    });
    p.direct = Some(para);
    p.before_direct = para_before;
    for ((r, d), b) in p.runs.iter_mut().zip(runs).zip(befores) {
        r.direct = d;
        r.before_direct = b;
    }
    for (seg, d) in p.segments.iter_mut().zip(segs) {
        seg.direct = Some(d);
    }
    for tb in p.text_boxes.iter_mut() {
        annotate_paragraphs(cat, &mut tb.paragraphs);
    }
}

fn annotate_paragraphs(cat: &LoweredDoc, ps: &mut [LoweredParagraph]) {
    for p in ps {
        annotate_paragraph(cat, p);
    }
}

fn annotate_table(cat: &LoweredDoc, t: &mut LoweredTable) {
    // The table's own paragraph aligns the table: paragraph properties
    // only (a character property there has no run; it keeps its style).
    t.direct = split_look(cat, t.para_style_id.as_deref())
        .filter(|(_, props)| !props.iter().any(|x| is_char(x)))
        .map(|(base, props)| look(base, &props));
    annotate_paragraphs(cat, &mut t.flow);
    for c in t.cells.iter_mut() {
        annotate_paragraphs(cat, &mut c.paragraphs);
        for n in c.nested.iter_mut() {
            annotate_table(cat, &mut n.table);
        }
    }
}

/// Write the pour's looks into `doc` (see the module docs) and the
/// synthesized styles it still applies, with those they stand on, into
/// `minted_styles`.
pub fn annotate(doc: &mut LoweredDoc) {
    // The catalogue the plans read (the styles are not changed here).
    let cat = LoweredDoc {
        styles: doc.styles.clone(),
        ..LoweredDoc::default()
    };
    for b in doc.story.blocks.iter_mut() {
        match b {
            LoweredBlock::Paragraph(p) => annotate_paragraph(&cat, p),
            LoweredBlock::Table(t) => annotate_table(&cat, t),
        }
    }
    for part in doc.header_footer_parts.iter_mut() {
        annotate_paragraphs(&cat, &mut part.paragraphs);
    }
    for note in doc.notes.iter_mut() {
        annotate_paragraphs(&cat, &mut note.paragraphs);
    }
    for item in doc.page_items.iter_mut() {
        if let LoweredItemKind::TextBox { paragraphs, .. } = &mut item.item {
            annotate_paragraphs(&cat, paragraphs);
        }
    }
    doc.minted_styles = Some(still_named(doc));
}

/// Every synthesized style the annotated `doc` still names where the pour
/// reads a style (a look's `style`, or a token no look stands for), and
/// the synthesized styles those stand on: a walk of the whole IR, so a
/// place that names a style and has no look keeps it minted.
fn still_named(doc: &LoweredDoc) -> Vec<String> {
    let mut out: BTreeSet<String> = BTreeSet::new();
    let value = serde_json::to_value(doc).unwrap_or_default();
    fn walk(v: &serde_json::Value, out: &mut BTreeSet<String>) {
        match v {
            serde_json::Value::String(s) if is_synthesized(s) => {
                out.insert(s.clone());
            }
            serde_json::Value::Array(a) => a.iter().for_each(|x| walk(x, out)),
            serde_json::Value::Object(o) => {
                // A look stands for the lowering's token beside it.
                let shadowed: &[&str] =
                    match (o.contains_key("direct"), o.contains_key("beforeDirect")) {
                        (true, true) => {
                            &["paraStyleId", "charStyleId", "formatChange", "propsChange"]
                        }
                        (true, false) => &["paraStyleId", "charStyleId"],
                        (false, true) => &["formatChange", "propsChange"],
                        (false, false) => &[],
                    };
                for (k, x) in o {
                    if !shadowed.contains(&k.as_str()) {
                        walk(x, out);
                    }
                }
            }
            _ => {}
        }
    }
    if let serde_json::Value::Object(o) = &value {
        for (k, x) in o {
            if k != "styles" && k != "mintedStyles" {
                walk(x, &mut out);
            }
        }
    }
    // The synthesized styles a kept one stands on.
    let by_id: HashMap<&str, Option<&str>> = doc
        .styles
        .iter()
        .map(|s| (s.id.as_str(), s.based_on.as_deref()))
        .collect();
    let mut todo: Vec<String> = out.iter().cloned().collect();
    while let Some(id) = todo.pop() {
        if let Some(Some(parent)) = by_id.get(id.as_str()) {
            if is_synthesized(parent) && out.insert((*parent).to_owned()) {
                todo.push((*parent).to_owned());
            }
        }
    }
    out.into_iter().collect()
}
