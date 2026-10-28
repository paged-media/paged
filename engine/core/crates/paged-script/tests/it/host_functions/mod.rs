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

//! One row per catalog host function (`paged-introspect/catalog.json` →
//! `hostFunctions`): the scripting layer's conformance table.
//!
//! Each row is one `#[test]` that names its function with the `covers!`
//! marker (`script:` and the function's name) and asserts, through `execute_script` on a
//! model built in code:
//!
//! - **argument validation** — a missing argument and a wrong-typed one:
//!   the error text the script sees, or (the bridge's rule for user input)
//!   the `false` / `null` it answers instead, with the document untouched;
//! - **the result shape** — the type of the return value, and the keys of
//!   the JSON a read returns;
//! - **the mutation effect** — the model's state before and after
//!   ([`snapshot`]: the whole serialized scene), and for every write that
//!   `paged.undo()` restores the before-state and `paged.redo()` the after.
//!
//! The rows live in one file per family below. `every_host_function_has_a_row`
//! is the enumeration gate: a host function added to the catalog without a
//! row here fails it, and so does a row naming a function the catalog does
//! not list.
//!
//! A row that exposes a product bug asserts the CURRENT behaviour under a
//! `// finding SCR-<n>` comment; the programme fixes nothing here.

use std::collections::{BTreeSet, HashMap};
use std::sync::{Mutex, OnceLock};

use paged_canvas::channel::CollectionName;
use paged_canvas::{CanvasModel, CanvasOptions};
use paged_script::{execute_script, ScriptResult};
use serde_json::Value;

mod console;
mod document;
mod frames;
mod history;
mod layers;
mod pages;
mod paths;
mod reads;
mod selection;
mod styles;
mod swatches;
mod tables;
mod text;
mod word_structure;
mod xml;

/// The row files, read for the enumeration gate.
const ROW_SOURCES: &[&str] = &[
    include_str!("console.rs"),
    include_str!("document.rs"),
    include_str!("frames.rs"),
    include_str!("history.rs"),
    include_str!("layers.rs"),
    include_str!("pages.rs"),
    include_str!("paths.rs"),
    include_str!("reads.rs"),
    include_str!("selection.rs"),
    include_str!("styles.rs"),
    include_str!("swatches.rs"),
    include_str!("tables.rs"),
    include_str!("text.rs"),
    include_str!("word_structure.rs"),
    include_str!("xml.rs"),
];

// ------------------------------------------------------------- fixtures

/// A blank letter page: one spread, one page, no stories.
pub fn blank() -> CanvasModel {
    CanvasModel::new_blank("host-fns", 612.0, 792.0, CanvasOptions::default()).expect("new_blank")
}

/// A `paged-gen` sample, built in code once per process and loaded fresh
/// per call (the corpus is never read).
pub fn sample(name: &str) -> CanvasModel {
    static BYTES: OnceLock<Mutex<HashMap<String, Vec<u8>>>> = OnceLock::new();
    let bytes = {
        let mut cache = BYTES
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .expect("fixture cache");
        cache
            .entry(name.to_string())
            .or_insert_with(|| {
                let s = paged_gen::samples::build(name)
                    .unwrap_or_else(|| panic!("paged-gen has no sample {name:?}"));
                paged_gen::write_idml(&s).expect("write the sample")
            })
            .clone()
    };
    CanvasModel::load(name, &bytes, CanvasOptions::default()).expect("load the sample")
}

/// A blank page with one text frame holding `text`. Returns the model, the
/// page id, the frame's address and the story id.
pub fn with_story(text: &str) -> (CanvasModel, String, String, String) {
    let mut m = blank();
    let out = ok(
        &mut m,
        &format!(
            "const pid = JSON.parse(paged.pages())[0].selfId;
             const tf = paged.insertTextFrame(pid, [72, 72, 400, 400]);
             const sid = JSON.parse(paged.stories())[0].selfId;
             paged.insertText(sid, 0, {text:?});
             JSON.stringify([pid, tf, sid]);"
        ),
    );
    let ids: Vec<String> = serde_json::from_str(last_line(&out)).expect("ids");
    (m, ids[0].clone(), ids[1].clone(), ids[2].clone())
}

/// The first page's id.
pub fn page_id(m: &mut CanvasModel) -> String {
    ok(m, "JSON.parse(paged.pages())[0].selfId")
}

// --------------------------------------------------------------- running

/// Run a script; whatever happened.
pub fn js(m: &mut CanvasModel, src: &str) -> ScriptResult {
    execute_script(m, src)
}

/// Run a script that must not throw; its output lines (the last
/// expression's value is the last line), joined.
pub fn ok(m: &mut CanvasModel, src: &str) -> String {
    let r = execute_script(m, src);
    assert!(r.error.is_none(), "script errored: {:?}\n{src}", r.error);
    r.output.join("\n")
}

/// Run a script that must throw; the error text.
pub fn err(m: &mut CanvasModel, src: &str) -> String {
    let r = execute_script(m, src);
    r.error
        .unwrap_or_else(|| panic!("expected a throw, got {:?}\n{src}", r.output))
}

pub fn last_line(out: &str) -> &str {
    out.lines().last().unwrap_or_default()
}

/// The JSON a read printed.
pub fn json_of(out: &str) -> Value {
    serde_json::from_str(last_line(out)).unwrap_or_else(|e| panic!("not JSON ({e}): {out:?}"))
}

/// The keys of a JSON object.
pub fn keys(v: &Value) -> BTreeSet<String> {
    v.as_object()
        .unwrap_or_else(|| panic!("not an object: {v}"))
        .keys()
        .cloned()
        .collect()
}

/// Assert `v` is an object carrying at least `want`.
pub fn has_keys(v: &Value, want: &[&str]) {
    let have = keys(v);
    for k in want {
        assert!(have.contains(*k), "{k:?} missing from {have:?}");
    }
}

// ----------------------------------------------------------------- state

/// The document's whole state: the serialized scene, plus the document
/// settings the model keeps beside it (colour management, proofing,
/// defaults: `documentMeta` without its `dirty` flag) and the ink list.
/// Selection and the undo log are application state and are not part of it.
pub fn snapshot(m: &CanvasModel) -> Value {
    let mut meta = serde_json::to_value(m.document_meta()).expect("the meta serializes");
    if let Some(o) = meta.as_object_mut() {
        o.remove("dirty");
    }
    serde_json::json!({
        "scene": serde_json::to_value(m.scene()).expect("the scene serializes"),
        "meta": meta,
        "inks": serde_json::to_value(m.collection(CollectionName::Inks)).expect("the inks serialize"),
    })
}

/// The JSON paths where `a` and `b` differ (at most 12), for failure
/// messages: which part of the document an undo failed to restore.
pub fn changed_paths(a: &Value, b: &Value) -> Vec<String> {
    fn walk(a: &Value, b: &Value, at: &str, out: &mut Vec<String>) {
        if out.len() >= 12 || a == b {
            return;
        }
        match (a, b) {
            (Value::Object(x), Value::Object(y)) => {
                let keys: BTreeSet<&String> = x.keys().chain(y.keys()).collect();
                for k in keys {
                    let (va, vb) = (
                        x.get(k).unwrap_or(&Value::Null),
                        y.get(k).unwrap_or(&Value::Null),
                    );
                    walk(va, vb, &format!("{at}.{k}"), out);
                }
            }
            (Value::Array(x), Value::Array(y)) if x.len() == y.len() => {
                for (i, (va, vb)) in x.iter().zip(y).enumerate() {
                    walk(va, vb, &format!("{at}[{i}]"), out);
                }
            }
            _ => {
                let short = |v: &Value| v.to_string().chars().take(160).collect::<String>();
                out.push(format!("{at}: {} -> {}", short(a), short(b)));
            }
        }
    }
    let mut out = Vec::new();
    walk(a, b, "", &mut out);
    out
}

/// Assert `call` answers `want` and leaves the document exactly as it was
/// — for a call whose arguments leave it nothing to do, but which is not
/// refused for that.
pub fn no_op(m: &mut CanvasModel, call: &str, want: &str) {
    refuses(m, call, want);
}

/// Assert `call` (a JS expression) writes: it answers `want`, the state
/// changes, `paged.undo()` restores the before-state and `paged.redo()`
/// the after-state. Returns the after-state.
pub fn writes(m: &mut CanvasModel, call: &str, want: &str) -> Value {
    let before = snapshot(m);
    let out = ok(m, call);
    assert_eq!(last_line(&out), want, "{call}");
    let after = snapshot(m);
    assert_ne!(before, after, "{call} answered {want} and changed nothing");
    assert_eq!(ok(m, "paged.undo()"), "true", "{call}: nothing to undo");
    let undone = snapshot(m);
    assert!(
        undone == before,
        "{call}: undo did not restore the before-state: {:?}",
        changed_paths(&before, &undone)
    );
    assert_eq!(ok(m, "paged.redo()"), "true", "{call}: nothing to redo");
    let redone = snapshot(m);
    assert!(
        redone == after,
        "{call}: redo did not restore the after-state: {:?}",
        changed_paths(&after, &redone)
    );
    after
}

/// Like [`writes`] when the answer is a minted id: checks its shape with
/// `shape`, returns it.
pub fn mints(m: &mut CanvasModel, call: &str, shape: impl Fn(&str) -> bool) -> String {
    let before = snapshot(m);
    let out = ok(m, call);
    let id = last_line(&out).to_string();
    assert!(shape(&id), "{call} minted {id:?}");
    let after = snapshot(m);
    assert_ne!(before, after, "{call} minted {id} and changed nothing");
    assert_eq!(ok(m, "paged.undo()"), "true", "{call}: nothing to undo");
    let undone = snapshot(m);
    assert!(
        undone == before,
        "{call}: undo did not restore the before-state: {:?}",
        changed_paths(&before, &undone)
    );
    assert_eq!(ok(m, "paged.redo()"), "true", "{call}: nothing to redo");
    let redone = snapshot(m);
    assert!(
        redone == after,
        "{call}: redo did not restore the after-state: {:?}",
        changed_paths(&after, &redone)
    );
    id
}

/// Assert `call` writes a document SETTING the engine keeps out of the undo
/// log (colour settings, proofing, defaults, inks: "app-level state, not
/// undoable" in the model): it answers `want` and changes the state, and a
/// following `paged.undo()` has nothing to undo (run it on a model with an
/// empty history).
pub fn sets(m: &mut CanvasModel, call: &str, want: &str) -> Value {
    let before = snapshot(m);
    let out = ok(m, call);
    assert_eq!(last_line(&out), want, "{call}");
    let after = snapshot(m);
    assert_ne!(before, after, "{call} answered {want} and changed nothing");
    assert_eq!(
        ok(m, "paged.undo()"),
        "false",
        "{call}: a setting is not an undo step"
    );
    assert!(snapshot(m) == after, "{call}: the setting stays");
    after
}

/// Assert `call` answers `want` (`false`, `null`, …) without throwing and
/// leaves the document as it was.
pub fn refuses(m: &mut CanvasModel, call: &str, want: &str) {
    let before = snapshot(m);
    let out = ok(m, call);
    assert_eq!(last_line(&out), want, "{call}");
    let now = snapshot(m);
    assert!(
        now == before,
        "{call} was refused and still wrote: {:?}",
        changed_paths(&before, &now)
    );
}

/// Assert `call` throws an error containing `text`, leaving the document
/// as it was.
pub fn throws(m: &mut CanvasModel, call: &str, text: &str) {
    let before = snapshot(m);
    let e = err(m, call);
    assert!(e.contains(text), "{call}: {e:?} does not say {text:?}");
    assert!(snapshot(m) == before, "{call} threw and still wrote");
}

/// Assert a read leaves the document as it was; returns its output.
pub fn reads(m: &mut CanvasModel, call: &str) -> String {
    let before = snapshot(m);
    let out = ok(m, call);
    assert!(snapshot(m) == before, "{call} is a read and wrote");
    out
}

/// What Boa says when a Symbol reaches a string conversion.
pub const SYMBOL_TO_STRING: &str = "TypeError";

// ------------------------------------------------------------------ gate

/// The enumeration gate: every catalog host function has a row in the
/// files above, and every row names a catalog function.
#[test]
fn every_host_function_has_a_row() {
    let catalog: BTreeSet<String> = paged_introspect::api_catalog()
        .host_functions
        .iter()
        .map(|f| f.name.to_string())
        .collect();
    assert!(
        catalog.len() > 150,
        "only {} host functions in the catalog — the reader lost its footing",
        catalog.len()
    );
    let needle = "covers!(\"script:";
    let mut rows: HashMap<String, usize> = HashMap::new();
    for src in ROW_SOURCES {
        for (i, _) in src.match_indices(needle) {
            let rest = &src[i + needle.len()..];
            let end = rest.find('"').expect("a closed literal");
            *rows.entry(rest[..end].to_string()).or_default() += 1;
        }
    }
    let named: BTreeSet<String> = rows.keys().cloned().collect();
    let missing: Vec<&String> = catalog.difference(&named).collect();
    assert!(
        missing.is_empty(),
        "host functions with no row — add a #[test] with covers!(\"script:<name>\") \
         to the family's file: {missing:?}"
    );
    let phantom: Vec<&String> = named.difference(&catalog).collect();
    assert!(
        phantom.is_empty(),
        "rows naming functions the catalog does not list: {phantom:?}"
    );
}
