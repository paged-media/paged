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

// Doc ADR 625 amendment — embedded placement as a batch of the engine's
// existing operations, built in Rust (`docx_skeleton::place`). Without an
// engine to apply them to, the operations are replayed on a bare list of
// characters (the story's contiguous offsets, the `insertText` space with its
// paragraph breaks) and compared with what the native builder holds: the same
// text, the same named styles, the same direct properties on every character
// and paragraph, and no invented style.

use std::collections::BTreeMap;

use docx_lower::ir::{LoweredDoc, PropValue};
use docx_skeleton::body::{
    is_synthesized, native_body, read_paragraph_props, read_run_props, NativeBlock,
};
use docx_skeleton::place::place_batch;
use serde_json::Value;

const STORY: &str = "$h:docFrame";

fn lowered(docx: &[u8]) -> LoweredDoc {
    docx_lower::lower(&docx_import::import_docx(docx).expect("import"))
}

#[derive(Default, Clone, PartialEq, Debug)]
struct Look {
    para_style: Option<String>,
    char_style: Option<String>,
    props: BTreeMap<String, Value>,
}

/// The operations replayed: per paragraph its look and, per character, its.
fn replay(ops: &[Value]) -> (Vec<Vec<char>>, Vec<Look>, Vec<Vec<Look>>) {
    let mut paras: Vec<Vec<char>> = vec![Vec::new()];
    let mut carets: Vec<(usize, String)> = Vec::new();
    let mut para_looks: Vec<Look> = Vec::new();
    let mut char_looks: Vec<Vec<Look>> = Vec::new();
    let mut ranged: Vec<Value> = Vec::new();
    for op in ops {
        let args = &op["args"];
        match op["op"].as_str().unwrap() {
            "insertText" => {
                assert_eq!(args["storyId"], STORY);
                assert_eq!(args["offset"], 0);
                paras = args["text"]
                    .as_str()
                    .unwrap()
                    .split('\n')
                    .map(|p| p.chars().collect())
                    .collect();
                para_looks = vec![Look::default(); paras.len()];
                char_looks = paras
                    .iter()
                    .map(|p| vec![Look::default(); p.len()])
                    .collect();
            }
            "applyStyle" | "setElementProperty" => ranged.push(op.clone()),
            other => panic!("unexpected operation {other}"),
        }
    }
    // Which paragraph holds contiguous offset `o`: the paragraph breaks do
    // not advance the offsets, so a range lies in the paragraphs it covers.
    let spans: Vec<(usize, usize)> = {
        let mut at = 0;
        paras
            .iter()
            .map(|p| {
                let s = (at, at + p.len());
                at += p.len();
                s
            })
            .collect()
    };
    for op in ranged {
        let args = &op["args"];
        if op["op"] == "applyStyle" {
            let (start, end) = (
                args["start"].as_u64().unwrap() as usize,
                args["end"].as_u64().unwrap() as usize,
            );
            let style = args["style"].as_str().unwrap().to_owned();
            if args["scope"] == "paragraph" {
                if start == end {
                    carets.push((args["paragraph"].as_u64().unwrap() as usize, style));
                } else {
                    let i = spans.iter().position(|s| s.0 == start && s.1 == end);
                    para_looks[i.expect("a paragraph range")].para_style = Some(style);
                }
            } else {
                for (i, (s, e)) in spans.iter().enumerate() {
                    for c in (*s).max(start)..(*e).min(end) {
                        char_looks[i][c - s].char_style = Some(style.clone());
                    }
                }
            }
        } else {
            let id = &args["elementId"]["id"];
            let (start, end) = (
                id["start"].as_u64().unwrap() as usize,
                id["end"].as_u64().unwrap() as usize,
            );
            let path = args["path"].as_str().unwrap().to_owned();
            if path.starts_with("paragraph") {
                let i = spans.iter().position(|s| s.0 == start && s.1 == end);
                para_looks[i.expect("a paragraph range")]
                    .props
                    .insert(path, args["value"].clone());
            } else {
                for (i, (s, e)) in spans.iter().enumerate() {
                    for c in (*s).max(start)..(*e).min(end) {
                        char_looks[i][c - s]
                            .props
                            .insert(path.clone(), args["value"].clone());
                    }
                }
            }
        }
    }
    for (i, style) in carets {
        para_looks[i].para_style = Some(style);
    }
    (paras, para_looks, char_looks)
}

fn wire(m: BTreeMap<String, PropValue>) -> BTreeMap<String, Value> {
    m.into_iter()
        .map(|(k, v)| (k, serde_json::to_value(v).unwrap()))
        .collect()
}

/// The placement of one document, checked against the native builder.
fn check(label: &str, doc: &LoweredDoc) -> Result<usize, String> {
    let batch = place_batch(doc, STORY)?;
    // The replay below knows text and ranges alone.
    if let Some(o) = batch.body_ops.iter().find(|o| {
        !matches!(
            o["op"].as_str(),
            Some("insertText" | "applyStyle" | "setElementProperty")
        )
    }) {
        return Err(format!("replays only text and ranges: {}", o["op"]));
    }
    let body = native_body(doc);
    let (paras, para_looks, char_looks) = replay(&batch.body_ops);
    assert_eq!(paras.len(), body.blocks.len(), "{label}: paragraph count");
    for (i, block) in body.blocks.iter().enumerate() {
        let NativeBlock::Paragraph(p) = block else {
            panic!("{label}: block {i} is not a paragraph");
        };
        let want: String = p.runs.iter().map(|r| r.text.as_str()).collect();
        assert_eq!(
            paras[i].iter().collect::<String>(),
            want,
            "{label}: text {i}"
        );
        assert_eq!(
            para_looks[i].para_style, p.paragraph_style,
            "{label}: paragraph style {i}"
        );
        if !want.is_empty() {
            assert_eq!(
                para_looks[i].props,
                wire(read_paragraph_props(p)),
                "{label}: paragraph properties {i}"
            );
        }
        let mut c = 0;
        for r in p.runs.iter().filter(|r| !r.text.is_empty()) {
            for _ in r.text.chars() {
                let look = &char_looks[i][c];
                assert_eq!(
                    look.char_style, r.character_style,
                    "{label}: character style {i}:{c}"
                );
                assert_eq!(
                    look.props,
                    wire(read_run_props(r)),
                    "{label}: character properties {i}:{c}"
                );
                c += 1;
            }
        }
    }
    // No invented style anywhere: not in the operations, not in the catalogue
    // (but a style a paragraph keeps, which is created).
    let created: Vec<&str> = batch
        .style_ops
        .iter()
        .filter(|o| o["op"].as_str().unwrap().starts_with("create") && o["op"] != "createSwatch")
        .filter_map(|o| o["args"]["selfId"].as_str())
        .collect();
    for op in &batch.body_ops {
        if let Some(s) = op["args"]["style"].as_str() {
            assert!(
                !is_synthesized(s) || created.contains(&s),
                "{label}: {s} is named and not created"
            );
        }
    }
    Ok(paras.len())
}

#[test]
fn a_paragraph_only_document_places_as_a_batch_equal_to_the_native_builder() {
    let fixtures = [
        ("mixed sizes", docx_conformance::mixed_sizes_docx()),
        (
            "paragraph spacing",
            docx_conformance::paragraph_spacing_docx(None),
        ),
        ("line spacing", docx_conformance::line_spacing_docx()),
        ("run specials", docx_conformance::run_specials_docx()),
        ("symbols", docx_conformance::symbols_docx()),
        ("memo", docx_conformance::memo_docx()),
    ];
    let mut placed = 0;
    let mut refused = Vec::new();
    for (label, bytes) in &fixtures {
        match check(label, &lowered(bytes)) {
            Ok(n) => {
                assert!(n > 0);
                placed += 1;
            }
            Err(why) => refused.push(format!("{label}: {why}")),
        }
    }
    assert!(placed >= 3, "placed {placed}, refused {refused:?}");
}

#[test]
fn a_document_with_something_not_yet_in_the_batch_is_refused_with_the_reason() {
    for (bytes, why) in [(docx_conformance::image_docx(), "picture")] {
        let err = place_batch(&lowered(&bytes), STORY).expect_err("refused");
        assert!(err.contains(why), "{why}: {err}");
    }
}

fn kinds(doc: &[u8]) -> Vec<String> {
    let batch = place_batch(&lowered(doc), STORY).expect("placed");
    batch
        .body_ops
        .iter()
        .map(|o| o["op"].as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn a_table_places_as_insert_table_cells_and_spans() {
    let k = kinds(&docx_conformance::table_docx());
    let at = |op: &str| k.iter().position(|x| x == op);
    assert!(at("insertTable") < at("bindCreated").map(|n| n + 1));
    assert!(k.iter().any(|x| x == "insertText"));
    assert_eq!(k.iter().filter(|x| *x == "insertTable").count(), 1);
}

#[test]
fn a_hyperlink_and_a_list_place_as_operations() {
    assert!(kinds(&docx_conformance::hyperlink_docx())
        .iter()
        .any(|x| x == "insertHyperlink"));
    let list = place_batch(&lowered(&docx_conformance::list_docx()), STORY).expect("placed");
    assert!(list
        .body_ops
        .iter()
        .any(|o| o["args"]["path"] == "paragraphListType"));
}
