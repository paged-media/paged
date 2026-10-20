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

//! Reads: element and story snapshots, the scene tree, the summaries of
//! every collection, selectors and addresses, schemas, property reads,
//! the planar arrangement, and the two host-registry reads (`invoke`,
//! `commands`). None of them writes.

use paged_script::{start_script, HostObjectAnswer, HostObjectCall, ScriptBudget, ScriptStep};

use super::*;

/// A page with a text frame ("Hello world") and an oval; returns the model,
/// the frame, the story and the oval.
fn content() -> (CanvasModel, String, String, String) {
    let (mut m, pid, tf, sid) = with_story("Hello world");
    let oval = ok(
        &mut m,
        &format!("paged.insertOval({pid:?}, [450, 100, 550, 200])"),
    );
    (m, tf, sid, oval)
}

/// A read that answers a JSON array: returns it, after checking the
/// document did not change.
fn array(m: &mut CanvasModel, call: &str) -> Vec<Value> {
    json_of(&reads(m, call))
        .as_array()
        .unwrap_or_else(|| panic!("{call} is not an array"))
        .clone()
}

#[test]
fn inspect() {
    covers!("script:paged.inspect");
    let (mut m, tf, sid, _) = content();
    assert_eq!(reads(&mut m, "paged.inspect()"), "null");
    assert_eq!(
        reads(&mut m, "paged.inspect('textFrame:no-such-frame')"),
        "null"
    );
    throws(&mut m, "paged.inspect(Symbol('i'))", SYMBOL_TO_STRING);
    let frame = json_of(&reads(&mut m, &format!("paged.inspect({tf:?})")));
    has_keys(&frame, &["id", "kind", "entries"]);
    assert!(frame["entries"].as_array().is_some_and(|e| !e.is_empty()));
    let story = json_of(&reads(&mut m, &format!("paged.inspect('story:{sid}')")));
    has_keys(&story, &["id", "kind", "name", "entries"]);
    assert_eq!(story["kind"], "Story");
    assert_eq!(story["entries"][0]["path"], "text");
}

#[test]
fn tree() {
    covers!("script:paged.tree");
    let (mut m, _, _, _) = content();
    let tree = array(&mut m, "paged.tree()");
    assert!(!tree.is_empty());
    let text = serde_json::to_string(&tree).unwrap();
    assert!(
        text.contains("oval") && text.contains("textFrame"),
        "{text}"
    );
    // Arguments are ignored.
    assert_eq!(
        reads(&mut m, "paged.tree(1, 2)"),
        reads(&mut m, "paged.tree()")
    );
}

#[test]
fn pages() {
    covers!("script:paged.pages");
    let mut m = blank();
    let pages = array(&mut m, "paged.pages()");
    assert_eq!(pages.len(), 1);
    has_keys(&pages[0], &["selfId", "index", "sizePt"]);
    assert_eq!(pages[0]["index"], 1, "1-based");
    assert_eq!(pages[0]["sizePt"], serde_json::json!([612.0, 792.0]));
}

#[test]
fn stories() {
    covers!("script:paged.stories");
    let (mut m, _, sid, _) = content();
    let stories = array(&mut m, "paged.stories()");
    assert_eq!(stories.len(), 1);
    has_keys(&stories[0], &["selfId", "characterCount", "paragraphCount"]);
    assert_eq!(stories[0]["selfId"], sid.as_str());
    assert_eq!(stories[0]["characterCount"], 11);
    assert_eq!(reads(&mut blank(), "paged.stories()"), "[]");
}

#[test]
fn layers() {
    covers!("script:paged.layers");
    let mut m = blank();
    assert_eq!(
        reads(&mut m, "paged.layers()"),
        "[]",
        "a blank document lists no layer"
    );
    ok(
        &mut m,
        "paged.layerInsert(0, 'Art'); paged.layerInsert(1, 'Ink')",
    );
    let layers = array(&mut m, "paged.layers()");
    assert_eq!(layers.len(), 2);
    has_keys(
        &layers[0],
        &["selfId", "name", "visible", "locked", "printable", "z"],
    );
}

#[test]
fn query() {
    covers!("script:paged.query");
    let (mut m, tf, _, oval) = content();
    assert_eq!(
        array(&mut m, "paged.query('oval')"),
        vec![Value::from(oval.clone())]
    );
    assert_eq!(
        array(&mut m, "paged.query('textFrame')"),
        vec![Value::from(tf)]
    );
    assert_eq!(array(&mut m, "paged.query('page')").len(), 1);
    assert_eq!(array(&mut m, "paged.query('rectangle')").len(), 0);
    // A selector that does not parse is a SyntaxError naming it.
    throws(&mut m, "paged.query('[[[')", "SyntaxError");
    throws(&mut m, "paged.query('[[[')", "paged.query(\"[[[\")");
    throws(&mut m, "paged.query(Symbol('s'))", SYMBOL_TO_STRING);
}

#[test]
fn schema() {
    covers!("script:paged.schema");
    let (mut m, _, _, oval) = content();
    let rows = array(&mut m, "paged.schema('page')");
    assert!(!rows.is_empty());
    has_keys(&rows[0], &["path"]);
    assert!(
        !array(&mut m, &format!("paged.schema({oval:?})")).is_empty(),
        "by address"
    );
    assert_eq!(reads(&mut m, "paged.schema('noSuchKind')"), "[]");
    throws(&mut m, "paged.schema(Symbol('k'))", SYMBOL_TO_STRING);
}

#[test]
fn address() {
    covers!("script:paged.address");
    let (mut m, _, sid, oval) = content();
    assert_eq!(reads(&mut m, &format!("paged.address({oval:?})")), oval);
    let pid = page_id(&mut m);
    assert_eq!(
        reads(&mut m, "paged.address('page:#1')"),
        format!("page:{pid}")
    );
    assert!(reads(&mut m, &format!("paged.address('story:{sid}')")).starts_with("story:"));
    assert_eq!(reads(&mut m, "paged.address('oval:no-such-oval')"), "null");
    assert_eq!(reads(&mut m, "paged.address()"), "null");
    // A `{ kind, id }` element object, as `paged.selection()` returns.
    let bare = oval.trim_start_matches("oval:");
    assert_eq!(
        reads(
            &mut m,
            &format!("paged.address({{ kind: 'oval', id: {bare:?} }})")
        ),
        oval
    );
    assert_eq!(reads(&mut m, "paged.address({ kind: 'nothing' })"), "null");
    throws(&mut m, "paged.address(Symbol('a'))", SYMBOL_TO_STRING);
}

/// Numbers compared at the engine's own precision (`f32`).
fn numbers_as_floats(v: Value) -> Value {
    match v {
        Value::Number(n) => serde_json::json!(n.as_f64().map(|f| f64::from(f as f32))),
        Value::Array(a) => Value::Array(a.into_iter().map(numbers_as_floats).collect()),
        Value::Object(o) => Value::Object(
            o.into_iter()
                .map(|(k, v)| (k, numbers_as_floats(v)))
                .collect(),
        ),
        other => other,
    }
}

/// The summary reads share one shape: `() -> Summary[] JSON`.
fn summary(read: &str, sample_name: &str, want: &[&str]) {
    let mut m = sample(sample_name);
    let rows = array(&mut m, &format!("paged.{read}()"));
    assert!(!rows.is_empty(), "{sample_name} has {read}");
    has_keys(&rows[0], want);
    // Arguments are ignored.
    assert_eq!(
        reads(&mut m, &format!("paged.{read}('x')")),
        reads(&mut m, &format!("paged.{read}()"))
    );
    // The generic read answers the same rows (its numbers may print as
    // floats where the typed read prints integers).
    let generic = numbers_as_floats(json_of(&reads(
        &mut m,
        &format!("paged.collection('{read}')"),
    )));
    let typed = numbers_as_floats(json_of(&reads(&mut m, &format!("paged.{read}()"))));
    assert!(
        generic == typed,
        "{read}: {:?}",
        changed_paths(&typed, &generic)
    );
}

#[test]
fn swatches() {
    covers!("script:paged.swatches");
    summary("swatches", "swatches", &["selfId", "name", "kind"]);
}

#[test]
fn paragraph_styles() {
    covers!("script:paged.paragraphStyles");
    summary("paragraphStyles", "styles-cascade", &["selfId", "name"]);
}

#[test]
fn character_styles() {
    covers!("script:paged.characterStyles");
    summary("characterStyles", "styles-cascade", &["selfId", "name"]);
}

#[test]
fn object_styles() {
    covers!("script:paged.objectStyles");
    summary("objectStyles", "object-style-frames", &["selfId", "name"]);
}

#[test]
fn gradients() {
    covers!("script:paged.gradients");
    summary("gradients", "gradients", &["selfId", "name"]);
}

#[test]
fn color_groups() {
    covers!("script:paged.colorGroups");
    let mut m = blank();
    assert_eq!(reads(&mut m, "paged.colorGroups()"), "[]");
    let sw = ok(
        &mut m,
        "paged.createSwatch({ space: 'CMYK', value: [0, 0, 0, 100], name: 'Ink' })",
    );
    ok(
        &mut m,
        &format!("paged.createColorGroup({{ name: 'Inks', members: [{sw:?}] }})"),
    );
    let rows = array(&mut m, "paged.colorGroups()");
    has_keys(&rows[0], &["selfId", "name"]);
    assert_eq!(
        json_of(&reads(&mut m, "paged.collection('colorGroups')")),
        json_of(&reads(&mut m, "paged.colorGroups()"))
    );
}

#[test]
fn links() {
    covers!("script:paged.links");
    summary(
        "links",
        "images",
        &["hostSelfId", "hostKind", "uri", "status"],
    );
    // finding SCR-11 (fixed): the generic read widened the engine's f32
    // numbers (`0.1` → `0.10000000149011612`) where `paged.links()` prints
    // them as written; both reads print the same value now.
    let mut m = sample("images");
    let typed = reads(&mut m, "paged.links()");
    let generic = reads(&mut m, "paged.collection('links')");
    assert!(
        typed.contains("0.1,") && !typed.contains("0.10000000149011612"),
        "{typed}"
    );
    assert!(
        generic.contains("0.1,") && !generic.contains("0.10000000149011612"),
        "{generic}"
    );
}

#[test]
fn conditions() {
    covers!("script:paged.conditions");
    summary("conditions", "conditions", &["selfId", "name", "visible"]);
}

#[test]
fn condition_sets() {
    covers!("script:paged.conditionSets");
    summary("conditionSets", "conditions", &["selfId", "name"]);
}

#[test]
fn collection() {
    covers!("script:paged.collection");
    let mut m = blank();
    // An unknown name answers `[]` and warns, never null.
    let r = js(&mut m, "paged.collection('noSuchCollection')");
    assert_eq!(r.error, None);
    assert_eq!(r.output.last().map(String::as_str), Some("[]"));
    assert!(r.output[0].contains("unknown collection"), "{:?}", r.output);
    let r = js(&mut m, "paged.collection()");
    assert_eq!(r.output.last().map(String::as_str), Some("[]"));
    throws(&mut m, "paged.collection(Symbol('c'))", SYMBOL_TO_STRING);
    for name in [
        "swatches",
        "layers",
        "spreads",
        "pages",
        "masterPages",
        "stories",
        "sections",
        "inks",
    ] {
        let rows = array(&mut m, &format!("paged.collection('{name}')"));
        if let Some(first) = rows.first() {
            assert!(first.is_object(), "{name}: {first}");
        }
    }
    assert!(!array(&mut m, "paged.collection('spreads')").is_empty());
}

#[test]
fn document_meta() {
    covers!("script:paged.documentMeta");
    let mut m = blank();
    let meta = json_of(&reads(&mut m, "paged.documentMeta()"));
    has_keys(
        &meta,
        &["pageCount", "units", "colorMode", "documentName", "dirty"],
    );
    assert_eq!(meta["pageCount"], 1);
    ok(&mut m, "paged.insertPage()");
    assert_eq!(
        json_of(&reads(&mut m, "paged.documentMeta()"))["pageCount"],
        2
    );
}

#[test]
fn planar_regions() {
    covers!("script:paged.planarRegions");
    let mut m = blank();
    let pid = page_id(&mut m);
    let a = ok(
        &mut m,
        &format!("paged.insertOval({pid:?}, [100, 100, 200, 200])"),
    );
    let b = ok(
        &mut m,
        &format!("paged.insertOval({pid:?}, [150, 150, 250, 250])"),
    );
    let all = json_of(&reads(
        &mut m,
        &format!("paged.planarRegions([{a:?}, {b:?}])"),
    ));
    has_keys(&all, &["found", "faces", "inputCount", "complete"]);
    assert_eq!(
        all["faces"].as_array().map(Vec::len),
        Some(3),
        "two overlapping ovals make three faces"
    );
    assert_eq!(all["inputCount"], 2);
    let one = json_of(&reads(
        &mut m,
        &format!("paged.planarRegions([{a:?}, {b:?}], [175, 175])"),
    ));
    assert_eq!(
        one["faces"].as_array().map(Vec::len),
        Some(1),
        "the face under the point"
    );
    let none = json_of(&reads(&mut m, "paged.planarRegions()"));
    assert_eq!(none["inputCount"], 0);
}

#[test]
fn get() {
    covers!("script:paged.get");
    let (mut m, tf, _, oval) = content();
    ok(&mut m, &format!("paged.set({oval:?}, 'frameOpacity', 40)"));
    // The answer is the wire value as JSON: `{ type, value }`.
    let v = json_of(&reads(
        &mut m,
        &format!("paged.get({oval:?}, 'frameOpacity')"),
    ));
    assert_eq!(v, serde_json::json!({ "type": "length", "value": 40.0 }));
    assert_eq!(
        reads(&mut m, &format!("paged.get({oval:?}, 'notAPath')")),
        "null"
    );
    assert_eq!(reads(&mut m, &format!("paged.get({oval:?})")), "null");
    assert_eq!(reads(&mut m, "paged.get()"), "null");
    assert_eq!(
        reads(&mut m, "paged.get('oval:no-such-oval', 'frameOpacity')"),
        "null"
    );
    assert!(!reads(&mut m, "paged.get('doc', 'documentBleedTop')").is_empty());
    assert_ne!(
        reads(&mut m, &format!("paged.get({tf:?}, 'frameBounds')")),
        "null"
    );
    throws(
        &mut m,
        &format!("paged.get({oval:?}, Symbol('p'))"),
        SYMBOL_TO_STRING,
    );
}

fn clock() -> f64 {
    0.0
}

/// Run `src` with a host registry; it must suspend on exactly one call,
/// which the host answers with `value`. Returns the call and the output.
fn through_host(m: &mut CanvasModel, src: &str, value: Value) -> (HostObjectCall, Vec<String>) {
    let (step, session) = start_script(m, src, ScriptBudget::default(), &clock, true, 1);
    let ScriptStep::Suspended { calls } = step else {
        panic!("{src}: expected the script to wait on the host, got {step:?}");
    };
    assert_eq!(calls.len(), 1, "{calls:?}");
    let answer = HostObjectAnswer { value, error: None };
    match session
        .expect("a session")
        .resume(m, &[answer], &[], &clock)
    {
        (ScriptStep::Done(r), None) => {
            assert_eq!(r.error, None, "{src}");
            (calls[0].clone(), r.output)
        }
        (other, _) => panic!("{src}: expected the script to finish, got {other:?}"),
    }
}

#[test]
fn invoke() {
    covers!("script:paged.invoke");
    let mut m = blank();
    // No host registry: commands live there, so the call throws noHost.
    throws(&mut m, "paged.invoke('core.insertPage', {})", "noHost");
    throws(&mut m, "paged.invoke(Symbol('c'))", SYMBOL_TO_STRING);
    let (call, out) = through_host(
        &mut m,
        "paged.invoke('core.insertPage', { after: null }).then(r => console.log(r))",
        serde_json::json!({ "created": ["page:u9"], "undoSteps": 1 }),
    );
    assert_eq!(
        call,
        HostObjectCall::Invoke {
            id: "core.insertPage".into(),
            args: serde_json::json!({ "after": null })
        }
    );
    let result = json_of(&out[0].replace("[log] ", ""));
    has_keys(&result, &["created", "undoSteps"]);
    // No args travel as null.
    let (call, _) = through_host(&mut m, "paged.invoke('core.undo')", Value::Null);
    assert_eq!(
        call,
        HostObjectCall::Invoke {
            id: "core.undo".into(),
            args: Value::Null
        }
    );
}

#[test]
fn commands() {
    covers!("script:paged.commands");
    let mut m = blank();
    throws(&mut m, "paged.commands()", "noHost");
    throws(&mut m, "paged.commands(Symbol('o'))", SYMBOL_TO_STRING);
    let (call, out) = through_host(
        &mut m,
        "paged.commands('core').then(r => console.log(r))",
        serde_json::json!([{ "id": "core.insertPage", "owner": "core" }]),
    );
    assert_eq!(
        call,
        HostObjectCall::Commands {
            owner: Some("core".into())
        }
    );
    let list = json_of(&out[0].replace("[log] ", ""));
    has_keys(&list[0], &["id", "owner"]);
    let (call, _) = through_host(&mut m, "paged.commands()", serde_json::json!([]));
    assert_eq!(call, HostObjectCall::Commands { owner: None });
}
