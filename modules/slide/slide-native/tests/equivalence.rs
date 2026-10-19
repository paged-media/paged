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

// ADR 708 — a deck built as a native document is the document the engine's
// IDML importer made of the IDML package slide-idml wrote: the two models,
// serialised as the `.paged` model part, are equal on every fixture and on
// the pptx corpus lane, and so are the reports beside them.

use std::path::{Path, PathBuf};

fn model_json(doc: &paged_scene::Document) -> serde_json::Value {
    serde_json::from_slice(&paged_store::to_bytes(doc).unwrap()).unwrap()
}

/// Every path where `a` and `b` differ (up to `limit`).
fn diffs(a: &serde_json::Value, b: &serde_json::Value, path: &str, out: &mut Vec<String>) {
    use serde_json::Value::*;
    if out.len() >= 40 {
        return;
    }
    match (a, b) {
        (Object(x), Object(y)) => {
            let mut keys: Vec<&std::string::String> = x.keys().chain(y.keys()).collect();
            keys.sort();
            keys.dedup();
            for k in keys {
                let (u, v) = (x.get(k).unwrap_or(&Null), y.get(k).unwrap_or(&Null));
                diffs(u, v, &format!("{path}.{k}"), out);
            }
        }
        (Array(x), Array(y)) if x.len() == y.len() => {
            for (i, (u, v)) in x.iter().zip(y).enumerate() {
                diffs(u, v, &format!("{path}[{i}]"), out);
            }
        }
        _ if a == b => {}
        _ => {
            let s = |v: &serde_json::Value| {
                let t = v.to_string();
                if t.len() > 160 {
                    format!("{}…", &t[..160])
                } else {
                    t
                }
            };
            out.push(format!("{path}: idml {} / native {}", s(a), s(b)));
        }
    }
}

/// Undo the entity escapes the IDML importer keeps in attributes it reads
/// raw (ids and style names the writer escaped).
fn unescape_strings(v: &mut serde_json::Value) {
    use serde_json::Value::*;
    match v {
        String(s) if s.contains('&') => {
            *s = s
                .replace("&lt;", "<")
                .replace("&gt;", ">")
                .replace("&quot;", "\"")
                .replace("&apos;", "'")
                .replace("&amp;", "&");
        }
        Array(a) => a.iter_mut().for_each(unescape_strings),
        Object(o) => {
            let entries: Vec<(std::string::String, serde_json::Value)> = std::mem::take(o)
                .into_iter()
                .map(|(mut k, mut v)| {
                    unescape_strings(&mut v);
                    if k.contains('&') {
                        let mut key = String(k.clone());
                        unescape_strings(&mut key);
                        if let String(s) = key {
                            k = s;
                        }
                    }
                    (k, v)
                })
                .collect();
            o.extend(entries);
        }
        _ => {}
    }
}

/// Compare the two paths for one deck; `None` when it does not import.
fn check(name: &str, bytes: &[u8]) -> Option<Vec<String>> {
    let deck = pptx_import::import_pptx(bytes).ok()?;
    let resolved = slide_resolve::resolve(&deck);
    let pkg = paged_ooxml::OpcPackage::read(bytes).ok()?;
    let images = |part: &str| pkg.part(part).map(|b| b.to_vec());
    let old = slide_idml::write(&resolved, &images, name).unwrap();
    let new = slide_native::build(&resolved, &images, name);
    let mut out = Vec::new();
    let mut a = model_json(&idml_import::import_idml_doc(&old.idml).unwrap());
    unescape_strings(&mut a);
    let b = model_json(&new.document);
    diffs(&a, &b, "", &mut out);
    if old.stories != new.stories {
        out.push("stories differ".into());
    }
    if old.elements != new.elements {
        out.push("elements differ".into());
    }
    if old.diagnostics != new.diagnostics {
        out.push(format!(
            "diagnostics: {:?} / {:?}",
            old.diagnostics, new.diagnostics
        ));
    }
    // What the bundle opens is the package: its model part decodes to the
    // same document.
    let written = slide_native::write(&resolved, &images, name).unwrap();
    let back = read_back(&written.paged);
    if model_json(&back) != b {
        out.push("the package's model part decodes to another document".into());
    }
    Some(out)
}

fn read_back(paged: &[u8]) -> paged_scene::Document {
    use std::io::Read;
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(paged)).unwrap();
    let mut pgm = Vec::new();
    let mut blobs = std::collections::HashMap::new();
    for i in 0..zip.len() {
        let mut f = zip.by_index(i).unwrap();
        let name = f.name().unwrap().to_string();
        let mut bytes = Vec::new();
        f.read_to_end(&mut bytes).unwrap();
        if name == paged_store::DOCUMENT_PGM_PATH {
            pgm = bytes;
        } else if let Some(b) = paged_store::blob_name_of(&name) {
            blobs.insert(b.to_string(), bytes);
        }
    }
    paged_store::from_parts(&pgm, blobs).expect("the model part decodes")
}

fn decks(dir: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(&d).unwrap().flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if p.extension().and_then(|x| x.to_str()) == Some("pptx") {
                files.push(p);
            }
        }
    }
    files.sort();
    files
}

fn run(files: &[PathBuf]) -> usize {
    let mut failures = Vec::new();
    let mut checked = 0;
    for f in files {
        let name = f.file_stem().unwrap().to_string_lossy().into_owned();
        let bytes = std::fs::read(f).unwrap();
        match check(&name, &bytes) {
            Some(d) if d.is_empty() => checked += 1,
            Some(d) => failures.push(format!("{}:\n  {}", f.display(), d.join("\n  "))),
            None => {}
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
    checked
}

#[test]
fn a_native_deck_is_the_imported_idml_deck() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../slide-conformance/fixtures");
    let files = decks(&dir);
    assert_eq!(run(&files), files.len(), "every fixture imports");
}

#[test]
#[ignore = "corpus: pptx"]
fn a_native_deck_is_the_imported_idml_deck_on_the_corpus() {
    let Some(dir) = paged_test_resources::corpus("pptx", &[]) else {
        return;
    };
    let files = decks(&dir);
    let checked = run(&files);
    eprintln!("equivalence: {checked} of {} corpus decks", files.len());
}
