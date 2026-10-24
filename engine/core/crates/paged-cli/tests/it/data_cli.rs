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

//! `paged data` (core ADR 1014): the engine reads the bindings a document's
//! labels carry and writes their values at one record, without the data
//! module, with every query passed through the query guard.

#![allow(non_snake_case)] // the `__feat__<id>` suffix links each test to its cockpit feature

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use serde_json::Value;

fn paged(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_paged"))
        .args(args)
        .output()
        .unwrap()
}

fn ok(out: Output) -> String {
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).unwrap()
}

fn s(p: &Path) -> &str {
    p.to_str().unwrap()
}

/// A rectangle whose label binds its opacity to `opacity` and the text
/// variable `paged:v_name` to `name`, reading `products` (as paged.data
/// writes it, data ADR 559), and a second query the guard must refuse.
pub(crate) const AUTHOR: &str = r#"
const parse = (v) => (typeof v === "string" ? JSON.parse(v) : v);
const pages = parse(paged.pages());
const frame = paged.insertFrame(pages[0].selfId, [72, 72, 200, 300]);
const label = {
  v: 1,
  data: {
    oid: "pd-0000cafe",
    bind: [
      { id: "op", kind: "property", target: "host", path: "frameOpacity", query: "q", expr: "opacity" },
      { id: "v_name", kind: "variable", target: "v_name", query: "q", expr: "name", missing: { missing: "blank" } },
    ],
    queries: [
      { id: "q", sql: "SELECT * FROM products ORDER BY name", params: [], shape: { shape: "recordStream" } },
      { id: "leak", sql: "SELECT * FROM read_csv('/etc/passwd')", params: [], shape: { shape: "recordStream" } },
    ],
    sources: [
      { id: "products", kind: { kind: "file", format: "csv", name: "products.csv" }, capability: "fs.read" },
    ],
  },
};
paged.setPluginMetadata(String(frame), "x-paged:media.paged.data", JSON.stringify(label));
paged.createTextVariable("paged:v_name", "<v_name>");
"#;

fn document(dir: &Path) -> PathBuf {
    let blank = dir.join("blank.paged");
    ok(paged(&["new", "--size", "a5", "--out", s(&blank)]));
    let script = dir.join("author.js");
    std::fs::write(&script, AUTHOR).unwrap();
    let doc = dir.join("bound.paged");
    ok(paged(&["script", s(&blank), s(&script), "-o", s(&doc)]));
    std::fs::write(dir.join("products.csv"), "name,opacity\nAda,40\nGrace,75\n").unwrap();
    doc
}

fn dir(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("paged-data-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[test]
fn data_bindings_lists_what_the_labels_carry__feat__data_bind_labels_native() {
    let d = dir("bindings");
    let doc = document(&d);
    let out: Value =
        serde_json::from_str(&ok(paged(&["data", "bindings", s(&doc), "--json"]))).unwrap();
    let ids: Vec<&str> = out["bindings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| b["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["op", "v_name"], "{out:#}");
    assert!(
        out["bindings"][0]["host"]
            .as_str()
            .unwrap()
            .starts_with("rectangle:"),
        "{out:#}"
    );
    assert_eq!(out["sources"][0]["file"], "products.csv", "{out:#}");
    assert_eq!(out["fromElements"], 2);
}

#[test]
fn data_apply_writes_the_bound_values_at_a_record__feat__data_bind_labels_native() {
    let d = dir("apply");
    let doc = document(&d);
    let saved = d.join("grace.paged");
    let csv = format!("products={}", s(&d.join("products.csv")));
    let report: Value = serde_json::from_str(&ok(paged(&[
        "data",
        "apply",
        s(&doc),
        "--source",
        &csv,
        "--record",
        "1",
        "-o",
        s(&saved),
        "--json",
    ])))
    .unwrap();
    let applied = report["applied"].as_array().unwrap();
    let op = applied.iter().find(|a| a["binding"] == "op").unwrap();
    assert_eq!(op["outcome"], "written", "{report:#}");
    let rect = op["targets"][0].as_str().unwrap().to_string();
    let var = applied.iter().find(|a| a["binding"] == "v_name").unwrap();
    assert_eq!(var["outcome"], "written", "{report:#}");
    assert_eq!(var["value"], "Grace", "{report:#}");
    // The document's second query reads a file: refused, and reported.
    let leak = report["queries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|q| q["query"] == "leak")
        .unwrap();
    assert!(
        leak["message"]
            .as_str()
            .unwrap()
            .contains("read_csv() reads files or URLs"),
        "{report:#}"
    );

    let opacity: Value =
        serde_json::from_str(&ok(paged(&["get", s(&saved), &rect, "frameOpacity"]))).unwrap();
    assert!(opacity.to_string().contains("75"), "{opacity}");
    let tv = ok(paged(&[
        "query",
        s(&saved),
        "textVariable[name=\"paged:v_name\"]",
    ]));
    let contents: Value = serde_json::from_str(&ok(paged(&[
        "get",
        s(&saved),
        tv.trim(),
        "textVariableContents",
    ])))
    .unwrap();
    assert!(contents.to_string().contains("Grace"), "{contents}");
}

#[test]
fn data_apply_without_a_source_file_says_which_it_needs() {
    let d = dir("missing");
    let doc = document(&d);
    let report: Value =
        serde_json::from_str(&ok(paged(&["data", "apply", s(&doc), "--json"]))).unwrap();
    assert_eq!(report["missingSources"][0], "products", "{report:#}");
    let q = report["queries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|q| q["query"] == "q")
        .unwrap();
    assert!(
        q["message"].as_str().unwrap().contains("failed"),
        "{report:#}"
    );
}
