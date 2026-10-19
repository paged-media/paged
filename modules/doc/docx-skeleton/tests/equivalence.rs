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

// ADR 606 — the native skeleton is the document the engine's IDML importer
// made of the IDML skeleton: the two models, serialised as the `.paged`
// model part, are equal on every fixture and both lowerings.

use docx_lower::sections::LowerOptions;

fn model_json(doc: &paged_scene::Document) -> serde_json::Value {
    serde_json::from_slice(&paged_store::to_bytes(doc).unwrap()).unwrap()
}

/// The first path where `a` and `b` differ.
fn diff(a: &serde_json::Value, b: &serde_json::Value, path: &str) -> Option<String> {
    use serde_json::Value::*;
    match (a, b) {
        (Object(x), Object(y)) => {
            for k in x.keys().chain(y.keys()) {
                let (u, v) = (x.get(k).unwrap_or(&Null), y.get(k).unwrap_or(&Null));
                if let Some(d) = diff(u, v, &format!("{path}.{k}")) {
                    return Some(d);
                }
            }
            None
        }
        (Array(x), Array(y)) if x.len() == y.len() => x
            .iter()
            .zip(y)
            .enumerate()
            .find_map(|(i, (u, v))| diff(u, v, &format!("{path}[{i}]"))),
        _ if a == b => None,
        _ => Some(format!("{path}: idml {a} / native {b}")),
    }
}

fn zip_entry(zip: &[u8], name: &str) -> Vec<u8> {
    use std::io::Read;
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(zip)).unwrap();
    let mut out = Vec::new();
    z.by_name(name).unwrap().read_to_end(&mut out).unwrap();
    out
}

fn check(name: &str, bytes: &[u8]) -> bool {
    let Ok(doc) = docx_import::import_docx(bytes) else {
        return false;
    };
    for options in [
        LowerOptions::default(),
        LowerOptions {
            mid_page_columns: false,
        },
    ] {
        let pages = docx_skeleton::skeleton_pages_with(&doc, options);
        let idml = docx_skeleton::idml::write_idml(&pages, name).unwrap();
        let mut old = idml_import::import_idml_doc(&idml).unwrap();
        // The IDML importer keeps the designmap's `Name` attribute escaped
        // (`&amp;` stays `&amp;`); the native document carries the name
        // itself. The one difference, and the old path's bug.
        if let Some(n) = old.designmap.document_name.as_mut() {
            *n = n
                .replace("&lt;", "<")
                .replace("&gt;", ">")
                .replace("&quot;", "\"")
                .replace("&apos;", "'")
                .replace("&amp;", "&");
        }
        // What the bundle opens: the `.paged` package, read back the way
        // the engine reads it.
        let sk = docx_skeleton::skeleton_with(&doc, name, options).unwrap();
        let pgm = zip_entry(&sk.paged, paged_store::DOCUMENT_PGM_PATH);
        let new = paged_store::from_bytes(&pgm).expect("the model part decodes");
        if let Some(d) = diff(&model_json(&old), &model_json(&new), "") {
            panic!("{name} ({options:?}): {d}");
        }
    }
    true
}

#[test]
fn the_native_skeleton_is_the_imported_idml_skeleton() {
    let fixtures: Vec<(&str, Vec<u8>)> = vec![
        ("pagination", docx_conformance::pagination_docx()),
        ("line_spacing", docx_conformance::line_spacing_docx()),
        ("tall_row", docx_conformance::tall_row_docx()),
        ("mixed_sizes", docx_conformance::mixed_sizes_docx()),
        (
            "paragraph_spacing",
            docx_conformance::paragraph_spacing_docx(None),
        ),
        ("breaks", docx_conformance::breaks_docx()),
        ("line_breaks", docx_conformance::line_breaks_docx()),
        ("run_specials", docx_conformance::run_specials_docx()),
        ("symbols", docx_conformance::symbols_docx()),
        ("continuous", docx_conformance::continuous_docx()),
        ("columns", docx_conformance::columns_docx()),
        ("memo", docx_conformance::memo_docx()),
        ("list", docx_conformance::list_docx()),
        ("table", docx_conformance::table_docx()),
        ("image", docx_conformance::image_docx()),
        ("hyperlink", docx_conformance::hyperlink_docx()),
        ("field_hyperlink", docx_conformance::field_hyperlink_docx()),
        ("merge_field", docx_conformance::merge_field_docx()),
        ("footnote", docx_conformance::footnote_docx()),
        ("simple_table", docx_conformance::simple_table_docx()),
        (
            "cell_blank_lines",
            docx_conformance::cell_blank_lines_docx(),
        ),
        ("nested_table", docx_conformance::nested_table_docx()),
        ("internal_anchor", docx_conformance::internal_anchor_docx()),
        ("header_field", docx_conformance::header_field_docx()),
        ("one_paragraph", docx_conformance::one_paragraph_docx()),
        ("headers", docx_conformance::headers_docx()),
        (
            "footnote_numbering",
            docx_conformance::footnote_numbering_docx(),
        ),
        ("floats", docx_conformance::floats_docx()),
        ("real_docx", docx_conformance::real_docx_docx()),
        ("keeps", docx_conformance::keeps_docx()),
        (
            "annual-report",
            std::fs::read(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../docx-conformance/fixtures/annual-report.docx"),
            )
            .unwrap(),
        ),
        (
            "merge-letter",
            std::fs::read(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../packages/doc-bundle/test/fixtures/merge-letter.docx"),
            )
            .unwrap(),
        ),
    ];
    for (name, bytes) in &fixtures {
        assert!(check(name, bytes), "{name}: imports");
    }
}

#[test]
#[ignore = "corpus: docx"]
fn the_native_skeleton_is_the_imported_idml_skeleton_on_the_corpus() {
    let Some(root) = paged_test_resources::corpus("docx", &[]) else {
        return;
    };
    let mut files = Vec::new();
    let mut stack = vec![root];
    while let Some(dir) = stack.pop() {
        for e in std::fs::read_dir(&dir).unwrap().flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if p
                .extension()
                .is_some_and(|x| ["docx", "dotx", "docm"].contains(&x.to_str().unwrap_or("")))
            {
                files.push(p);
            }
        }
    }
    files.sort();
    let mut checked = 0;
    for f in &files {
        let bytes = std::fs::read(f).unwrap();
        if check(&f.display().to_string(), &bytes) {
            checked += 1;
        }
    }
    eprintln!("equivalence: {checked} of {} corpus files", files.len());
}
