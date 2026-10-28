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

/// What a script sees of the bound document's data (PM-0015).
const READ_DATA: &str = r#"
const t = paged.data.tables();
console.log("tables", JSON.stringify(t.tables));
console.log("q", t.queries.find((q) => q.id === "q").rowCount);
console.log("leak", t.queries.find((q) => q.id === "leak").error);
const r = paged.data.query("SELECT name, opacity FROM products WHERE opacity > 50");
console.log("query", r.rowCount, r.schema.fields.map((f) => f.name).join("|"), r.columns[0][0]);
const w = paged.data.records("products", { offset: 1, limit: 1 });
console.log("records", w.rowCount, w.columns[0][0]);
console.log("evaluate", paged.data.evaluate("q", "UPPER(name)", 1).display);
try {
  paged.data.query("SELECT * FROM read_csv('/etc/passwd')");
  console.log("refused", false);
} catch (e) {
  console.log("refused", e.message);
}
"#;

#[test]
fn a_script_reads_the_bound_document_s_data__feat__data_bind_labels_native() {
    let d = dir("script");
    let doc = document(&d);
    let script = d.join("read.js");
    std::fs::write(&script, READ_DATA).unwrap();
    let csv = format!("products={}", s(&d.join("products.csv")));
    let out = ok(paged(&["script", s(&doc), s(&script), "--source", &csv]));
    let lines: Vec<&str> = out.lines().collect();
    assert_eq!(lines[0], "[log] tables [\"products\"]", "{out}");
    assert_eq!(lines[1], "[log] q 2", "{out}");
    assert!(lines[2].contains("read_csv() reads files or URLs"), "{out}");
    assert_eq!(lines[3], "[log] query 1 name|opacity Grace", "{out}");
    assert_eq!(lines[4], "[log] records 1 Grace", "{out}");
    assert_eq!(lines[5], "[log] evaluate GRACE", "{out}");
    // A script's own SQL meets the same guard as the document's queries.
    assert!(
        lines[6].starts_with("[log] refused paged.data: not run:")
            && lines[6].contains("read_csv() reads files or URLs"),
        "{out}"
    );
}

#[test]
fn a_script_without_data_is_told_so__feat__data_bind_labels_native() {
    let d = dir("nodata");
    let blank = d.join("blank.paged");
    ok(paged(&["new", "--size", "a5", "--out", s(&blank)]));
    let script = d.join("probe.js");
    std::fs::write(
        &script,
        r#"try { paged.data.tables(); console.log("answered"); }
           catch (e) { console.log(e.name, e.message.includes("no data is attached")); }"#,
    )
    .unwrap();
    let out = ok(paged(&["script", s(&blank), s(&script)]));
    assert_eq!(out.trim(), "[log] TypeError true");

    // A --source alone attaches its file, by the file's extension.
    std::fs::write(d.join("people.csv"), "name\nAda\nGrace\n").unwrap();
    std::fs::write(
        &script,
        r#"console.log(paged.data.query("SELECT COUNT(*) AS n FROM people").columns[0][0]);"#,
    )
    .unwrap();
    let csv = format!("people={}", s(&d.join("people.csv")));
    let out = ok(paged(&["script", s(&blank), s(&script), "--source", &csv]));
    assert_eq!(out.trim(), "[log] 2");
}

// ── The lowered kinds, written headless (core ADR 1014, amendment 2026-10-28)

/// Four page items, each carrying one lowered binding in its label as
/// paged.data writes them (data ADR 559): a rectangle whose visibility and
/// fill colour are bound, a text frame holding a table and a rule over its
/// price column, a rectangle bound to an image file (and a second one to a
/// remote uri), a rectangle bound to an EAN-13 symbol, and a record flow.
const AUTHOR_LOWERED: &str = r#"
const parse = (v) => (typeof v === "string" ? JSON.parse(v) : v);
const pid = parse(paged.pages())[0].selfId;
const rect = paged.insertFrame(pid, [72, 72, 200, 300]);
const text = paged.insertTextFrame(pid, [220, 72, 400, 400]);
const pic = paged.insertFrame(pid, [420, 72, 520, 200]);
const bar = paged.insertFrame(pid, [420, 250, 500, 400]);
const web = paged.insertFrame(pid, [530, 72, 580, 200]);
const queries = [{ id: "q", sql: "SELECT * FROM products ORDER BY name", params: [], shape: { shape: "recordStream" } }];
const sources = [{ id: "products", kind: { kind: "file", format: "csv", name: "products.csv" }, capability: "fs.read" }];
const label = (frame, oid, bind, extra) =>
  paged.setPluginMetadata(String(frame), "x-paged:media.paged.data",
    JSON.stringify({ v: 1, data: { oid, bind, queries, sources, extra: extra || {} } }));
label(rect, "pd-0000a001", [
  { id: "shown", kind: "visibility", target: "host", query: "q", expr: "shown" },
  { id: "fill", kind: "property", target: "host", path: "frameFillColor", query: "q", expr: "colour",
    schema: { type: { kind: "color" } } },
]);
label(text, "pd-0000a002", [
  { id: "prices", kind: "table", region: "host", query: "q",
    columns: [{ header: "Name", expr: "name" }, { header: "Price", expr: "price" }] },
  { id: "dear", kind: "rule", scope: "prices", when: "price > 15", apply: { action: "tableStyle", name: "Dear" } },
  { id: "flow", kind: "recordFlow", chain: "host", query: "q", template: "card" },
], { dear: { query: "q", target: { kind: "tableColumn", storyId: "$story", tableId: "$table", tableIndex: 0, col: 1, headerRows: 0 } } });
label(pic, "pd-0000a003", [{ id: "photo", kind: "image", target: "host", query: "q", expr: "photo" }],
  { photo: { fit: "FillProportionally" } });
label(bar, "pd-0000a004", [{ id: "ean", kind: "barcode", target: "host", query: "q", symbology: "ean13", expr: "ean" }]);
label(web, "pd-0000a005", [{ id: "remote", kind: "image", target: "host", query: "q", expr: "remote" }]);
const stock = paged.insertFrame(pid, [590, 72, 640, 200]);
label(stock, "pd-0000a006", [{ id: "stock", kind: "image", target: "host", query: "q", expr: "stock" }]);
// The record template the flow places, in the document label's recipe: two
// lines of 300 pt, so each record takes a page of its own.
paged.setDocumentMetadata("x-paged:media.paged.data", JSON.stringify({ v: 1, data: { recipe: {
  templates: [{ id: "card", fields: [{ label: "", expr: "name" }, { label: "Price: ", expr: "price" }], lineHeightPt: 300 }],
} } }));
"#;

/// A `w × h` solid red RGB PNG, stored (uncompressed) deflate: no encoder.
fn red_png(w: u32, h: u32) -> Vec<u8> {
    fn crc32(data: &[u8]) -> u32 {
        let mut crc = 0xffff_ffffu32;
        for byte in data {
            crc ^= u32::from(*byte);
            for _ in 0..8 {
                crc = if crc & 1 != 0 {
                    (crc >> 1) ^ 0xedb8_8320
                } else {
                    crc >> 1
                };
            }
        }
        !crc
    }
    fn chunk(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
        let mut out = (body.len() as u32).to_be_bytes().to_vec();
        out.extend_from_slice(kind);
        out.extend_from_slice(body);
        let crc = crc32(&[&kind[..], body].concat());
        out.extend_from_slice(&crc.to_be_bytes());
        out
    }
    let raw: Vec<u8> = (0..h)
        .flat_map(|_| std::iter::once(0).chain((0..w).flat_map(|_| [255, 0, 0])))
        .collect();
    let mut z = vec![0x78, 0x01, 0x01];
    z.extend_from_slice(&(raw.len() as u16).to_le_bytes());
    z.extend_from_slice(&(!(raw.len() as u16)).to_le_bytes());
    z.extend_from_slice(&raw);
    let (mut a, mut b) = (1u32, 0u32);
    for byte in &raw {
        a = (a + u32::from(*byte)) % 65521;
        b = (b + a) % 65521;
    }
    z.extend_from_slice(&((b << 16) | a).to_be_bytes());
    let mut ihdr = w.to_be_bytes().to_vec();
    ihdr.extend_from_slice(&h.to_be_bytes());
    ihdr.extend_from_slice(&[8, 2, 0, 0, 0]);
    let mut png = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    png.extend(chunk(b"IHDR", &ihdr));
    png.extend(chunk(b"IDAT", &z));
    png.extend(chunk(b"IEND", &[]));
    png
}

/// The lowered-bindings document, its CSV and the picture next to it.
fn lowered_document(dir: &Path) -> PathBuf {
    let blank = dir.join("blank.paged");
    ok(paged(&["new", "--size", "a4", "--out", s(&blank)]));
    let script = dir.join("author.js");
    std::fs::write(&script, AUTHOR_LOWERED).unwrap();
    let doc = dir.join("lowered.paged");
    ok(paged(&["script", s(&blank), s(&script), "-o", s(&doc)]));
    std::fs::write(
        dir.join("products.csv"),
        "name,price,shown,colour,photo,ean,remote,stock\n\
         Ada,10,true,#ff0000,red.png,4006381333931,https://example.com/a.png,asset:logo-a\n\
         Grace,20,false,#00ff00,red.png,5901234123457,https://example.com/g.png,asset:logo-g\n",
    )
    .unwrap();
    std::fs::write(dir.join("red.png"), red_png(3, 4)).unwrap();
    doc
}

/// `paged data apply DOC --record N -o OUT --json`, its `applied` rows by id.
fn apply_lowered(dir: &Path, doc: &Path, record: &str, out: &Path) -> Vec<Value> {
    let csv = format!("products={}", s(&dir.join("products.csv")));
    let report: Value = serde_json::from_str(&ok(paged(&[
        "data",
        "apply",
        s(doc),
        "--source",
        &csv,
        "--record",
        record,
        "-o",
        s(out),
        "--json",
    ])))
    .unwrap();
    report["applied"].as_array().unwrap().clone()
}

fn row<'a>(applied: &'a [Value], id: &str) -> &'a Value {
    applied
        .iter()
        .find(|a| a["binding"] == id)
        .unwrap_or_else(|| panic!("no row for {id}: {applied:#?}"))
}

/// Every file of an IDML package whose name starts with `prefix`, joined.
fn idml_parts(idml: &Path, prefix: &str) -> String {
    let mut zip = zip::ZipArchive::new(std::fs::File::open(idml).unwrap()).unwrap();
    let mut out = String::new();
    for i in 0..zip.len() {
        let mut f = zip.by_index(i).unwrap();
        if f.name().unwrap().starts_with(prefix) {
            std::io::Read::read_to_string(&mut f, &mut out).unwrap();
        }
    }
    out
}

fn lines(text: &str) -> Vec<String> {
    text.lines().map(str::to_string).collect()
}

#[test]
fn data_apply_writes_a_visibility_binding_as_the_element_s_own_property__feat__data_bind_labels_native(
) {
    let d = dir("visibility");
    let doc = lowered_document(&d);
    let saved = d.join("grace.paged");
    let applied = apply_lowered(&d, &doc, "1", &saved);
    let shown = row(&applied, "shown");
    assert_eq!(shown["outcome"], "written", "{shown:#}");
    assert_eq!(shown["path"], "elementVisible");
    let rect = shown["targets"][0].as_str().unwrap();
    let visible = ok(paged(&["get", s(&saved), rect, "elementVisible"]));
    assert!(visible.contains("false"), "{visible}");
    // Record 0 shows it again.
    let again = d.join("ada.paged");
    apply_lowered(&d, &saved, "0", &again);
    let visible = ok(paged(&["get", s(&again), rect, "elementVisible"]));
    assert!(visible.contains("true"), "{visible}");
}

#[test]
fn data_apply_writes_a_table_in_its_frame_and_replaces_it_on_the_next_apply__feat__data_bind_labels_native(
) {
    let d = dir("table");
    let doc = lowered_document(&d);
    // Through IDML, as InDesign would carry the labels between two runs.
    let first = d.join("first.idml");
    let applied = apply_lowered(&d, &doc, "0", &first);
    let table = row(&applied, "prices");
    assert_eq!(table["outcome"], "written", "{table:#}");
    assert_eq!(table["value"]["rows"], 2, "{table:#}");
    assert_eq!(table["value"]["cols"], 2, "{table:#}");
    let stories = idml_parts(&first, "Stories/");
    assert_eq!(stories.matches("<Table ").count(), 1, "{stories}");
    for cell in ["Ada", "Grace", "10", "20"] {
        assert!(
            stories.contains(&format!("<Content>{cell}</Content>")),
            "{cell}: {stories}"
        );
    }

    let second = d.join("second.idml");
    let applied = apply_lowered(&d, &first, "0", &second);
    let table = row(&applied, "prices");
    assert_eq!(table["outcome"], "written", "{table:#}");
    assert!(
        table["message"]
            .as_str()
            .unwrap()
            .starts_with("replaced table"),
        "{table:#}"
    );
    let stories = idml_parts(&second, "Stories/");
    assert_eq!(stories.matches("<Table ").count(), 1, "{stories}");
    assert_eq!(lines(&ok(paged(&["query", s(&second), "table"]))).len(), 1);

    // The rule styles the fired row's price cell (Grace, 20 > 15) after the
    // table it styles was placed.
    let rule = row(&applied, "dear");
    assert_eq!(rule["outcome"], "written", "{rule:#}");
    assert_eq!(rule["value"]["fired"], 1, "{rule:#}");
    let cell = rule["targets"][0].as_str().unwrap();
    assert!(cell.ends_with("/1,1"), "{rule:#}");
    let style = ok(paged(&["get", s(&second), cell, "appliedCellStyle"]));
    assert!(style.contains("CellStyle/Dear"), "{style}");
}

#[test]
fn data_apply_places_a_local_image_and_leaves_a_remote_one_to_the_editor__feat__data_bind_labels_native(
) {
    let d = dir("image");
    let doc = lowered_document(&d);
    let saved = d.join("placed.idml");
    let applied = apply_lowered(&d, &doc, "0", &saved);
    let photo = row(&applied, "photo");
    assert_eq!(photo["outcome"], "written", "{photo:#}");
    assert_eq!(photo["value"]["fit"], "FillProportionally", "{photo:#}");
    let frame = photo["targets"][0].as_str().unwrap();
    let fit = ok(paged(&["get", s(&saved), frame, "frameFittingType"]));
    assert!(fit.contains("FillProportionally"), "{fit}");
    // The picture is in the frame, fitted: 3 × 4 px filling 128 × 100 pt.
    let id = frame.split_once(':').unwrap().1;
    let spreads = idml_parts(&saved, "Spreads/");
    let image = format!("<Image Self=\"{id}Image\" ItemTransform=\"42.66");
    assert!(spreads.contains(&image), "{spreads}");

    let remote = row(&applied, "remote");
    assert_eq!(remote["outcome"], "notHeadless", "{remote:#}");
    assert!(
        remote["message"]
            .as_str()
            .unwrap()
            .contains("remote images need the editor's consented fetch"),
        "{remote:#}"
    );
}

#[test]
fn data_apply_draws_a_barcode_and_replaces_its_symbol_on_the_next_apply__feat__data_bind_labels_native(
) {
    let d = dir("barcode");
    let doc = lowered_document(&d);
    let first = d.join("first.paged");
    let applied = apply_lowered(&d, &doc, "0", &first);
    let ean = row(&applied, "ean");
    assert_eq!(ean["outcome"], "written", "{ean:#}");
    assert_eq!(ean["value"]["text"], "4006381333931", "{ean:#}");
    let modules = ean["value"]["modules"].as_u64().unwrap() as usize;
    assert!(modules > 20, "{ean:#}");
    let polygons = lines(&ok(paged(&["query", s(&first), "polygon"])));
    assert_eq!(polygons.len(), modules);
    let fill = ok(paged(&["get", s(&first), &polygons[0], "frameFillColor"]));
    assert!(fill.contains("Color/Black"), "{fill}");

    let second = d.join("second.paged");
    let applied = apply_lowered(&d, &first, "1", &second);
    let ean = row(&applied, "ean");
    assert_eq!(ean["value"]["text"], "5901234123457", "{ean:#}");
    assert_eq!(
        ean["message"],
        format!("replaced {modules} module(s) of the previous symbol"),
        "{ean:#}"
    );
    let polygons = lines(&ok(paged(&["query", s(&second), "polygon"])));
    assert_eq!(
        polygons.len(),
        ean["value"]["modules"].as_u64().unwrap() as usize
    );
}

#[test]
fn data_apply_replaces_a_symbol_the_editor_drew_whole__feat__data_bind_labels_native() {
    let d = dir("barcode-editor");
    let doc = lowered_document(&d);
    let first = d.join("first.paged");
    let applied = apply_lowered(&d, &doc, "0", &first);
    let modules = row(&applied, "ean")["value"]["modules"].as_u64().unwrap();
    // The data module's own writer labels only the LAST module of a symbol,
    // with the symbol's module count, and draws the rest just before it.
    let editor = d.join("editor.paged");
    let script = d.join("editor.js");
    std::fs::write(
        &script,
        r#"const q = paged.query("polygon");
for (let i = 0; i < q.length - 1; i++) paged.setPluginMetadata(String(q[i]), "x-paged:media.paged.data", null);
paged.setPluginMetadata(String(q[q.length - 1]), "x-paged:media.paged.data",
  JSON.stringify({ v: 1, data: { kind: "barcode", binding: "ean", modules: q.length } }));
"#,
    )
    .unwrap();
    ok(paged(&["script", s(&first), s(&script), "-o", s(&editor)]));

    let second = d.join("second.paged");
    let applied = apply_lowered(&d, &editor, "1", &second);
    let ean = row(&applied, "ean");
    assert_eq!(
        ean["message"],
        format!("replaced {modules} module(s) of the previous symbol"),
        "{ean:#}"
    );
    let polygons = lines(&ok(paged(&["query", s(&second), "polygon"])));
    assert_eq!(
        polygons.len(),
        ean["value"]["modules"].as_u64().unwrap() as usize
    );
}

#[test]
fn data_apply_mints_a_colour_no_swatch_has_once__feat__data_bind_labels_native() {
    let d = dir("colour");
    let doc = lowered_document(&d);
    let first = d.join("first.paged");
    let applied = apply_lowered(&d, &doc, "1", &first);
    let fill = row(&applied, "fill");
    assert_eq!(fill["outcome"], "written", "{fill:#}");
    assert_eq!(fill["value"], "Color/R=0 G=255 B=0", "{fill:#}");
    let rect = fill["targets"][0].as_str().unwrap();
    let got = ok(paged(&["get", s(&first), rect, "frameFillColor"]));
    assert!(got.contains("Color/R=0 G=255 B=0"), "{got}");

    // Applied again, the swatch is found, not minted a second time.
    let second = d.join("second.paged");
    apply_lowered(&d, &first, "1", &second);
    let swatches = lines(&ok(paged(&["query", s(&second), "swatch"])));
    let minted = swatches
        .iter()
        .filter(|s| s.contains("R=0 G=255 B=0"))
        .count();
    assert_eq!(minted, 1, "{swatches:?}");
}

#[test]
fn data_apply_leaves_a_document_asset_id_unwritten_and_says_why__feat__data_bind_labels_native() {
    let d = dir("asset");
    let doc = lowered_document(&d);
    let applied = apply_lowered(&d, &doc, "0", &d.join("out.paged"));
    let stock = row(&applied, "stock");
    assert_eq!(stock["outcome"], "notHeadless", "{stock:#}");
    assert!(
        stock["message"]
            .as_str()
            .unwrap()
            .starts_with("asset:logo-a: no asset store keeps an asset id's bytes"),
        "{stock:#}"
    );
}

/// The frames a record flow placed, by their stamp (`"frame": <n>`; the
/// bound frame's own label names the binding's kind too).
fn flow_frames(doc: &Path) -> Vec<String> {
    lines(&ok(paged(&[
        "query",
        s(doc),
        r#"textFrame[label.x-paged:media.paged.data*="\"frame\":"]"#,
    ])))
}

#[test]
fn data_apply_places_a_record_flow_over_added_pages_and_replaces_it_on_the_next_apply__feat__data_bind_labels_native(
) {
    let d = dir("flow");
    let doc = lowered_document(&d);
    let pages_before = lines(&ok(paged(&["query", s(&doc), "page"]))).len();
    // Through IDML, as InDesign would carry the stamps between two runs.
    let first = d.join("first.idml");
    let applied = apply_lowered(&d, &doc, "1", &first);
    let flow = row(&applied, "flow");
    assert_eq!(flow["outcome"], "written", "{flow:#}");
    // A flow places every record: `--record 1` does not restrict it. Each
    // 600 pt record takes a margin box of its own, the second on a page
    // the flow added after the start page.
    assert_eq!(flow["value"]["placed"], 2, "{flow:#}");
    assert_eq!(flow["value"]["total"], 2, "{flow:#}");
    assert_eq!(flow["value"]["frames"], 2, "{flow:#}");
    assert_eq!(flow["value"]["addedPages"], 1, "{flow:#}");
    assert_eq!(flow["value"]["overset"], serde_json::json!([]), "{flow:#}");
    assert_eq!(
        lines(&ok(paged(&["query", s(&first), "page"]))).len(),
        pages_before + 1
    );
    assert_eq!(flow_frames(&first).len(), 2);
    let stories = idml_parts(&first, "Stories/");
    for text in ["Ada", "Price: 10", "Grace", "Price: 20"] {
        assert!(stories.contains(text), "{text}: {stories}");
    }
    let spreads = idml_parts(&first, "Spreads/");
    assert!(spreads.contains("createdPage"), "{spreads}");

    // Applied again, the previous frames and the page they added go, and
    // the new flow takes their place: no second set of frames or pages.
    let second = d.join("second.paged");
    let applied = apply_lowered(&d, &first, "0", &second);
    let flow = row(&applied, "flow");
    assert_eq!(flow["outcome"], "written", "{flow:#}");
    assert_eq!(
        flow["message"], "replaced 2 frame(s) and 1 added page(s) of the previous flow",
        "{flow:#}"
    );
    assert_eq!(
        lines(&ok(paged(&["query", s(&second), "page"]))).len(),
        pages_before + 1
    );
    let frames = flow_frames(&second);
    assert_eq!(frames.len(), 2, "{frames:?}");
    assert_eq!(
        frames,
        flow["targets"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t.as_str().unwrap().to_string())
            .collect::<Vec<_>>()
    );

    // Nothing else is left unwritten but the two references no headless
    // lane can resolve.
    let rest: Vec<&Value> = applied
        .iter()
        .filter(|a| {
            a["outcome"] != "written" && a["binding"] != "remote" && a["binding"] != "stock"
        })
        .collect();
    assert!(rest.is_empty(), "{rest:#?}");
}

/// A record flow the editor lowered and synced: its first frame carries the
/// binding itself (`bind`) next to the flow's stamp.
const AUTHOR_LOWERED_FLOW: &str = r#"
const pid = JSON.parse(paged.pages())[0].selfId;
const first = paged.insertTextFrame(pid, [36, 36, 400, 400]);
paged.setPluginMetadata(String(first), "x-paged:media.paged.data", JSON.stringify({ v: 1, data: {
  oid: "pd-0000f001",
  bind: [{ id: "flow", kind: "recordFlow", chain: "host", query: "q", template: "card" }],
  queries: [{ id: "q", sql: "SELECT * FROM products ORDER BY name", params: [], shape: { shape: "recordStream" } }],
  sources: [{ id: "products", kind: { kind: "file", format: "csv", name: "products.csv" }, capability: "fs.read" }],
  kind: "recordFlow", binding: "flow", frame: 0,
} }));
paged.setDocumentMetadata("x-paged:media.paged.data", JSON.stringify({ v: 1, data: { recipe: {
  templates: [{ id: "card", fields: [{ label: "", expr: "name" }], lineHeightPt: 14 }],
} } }));
"#;

#[test]
fn data_apply_keeps_a_record_flow_s_binding_when_it_replaces_the_frame_that_carried_it__feat__data_bind_labels_native(
) {
    let d = dir("flow-carried");
    let blank = d.join("blank.paged");
    ok(paged(&["new", "--size", "a4", "--out", s(&blank)]));
    let script = d.join("author.js");
    std::fs::write(&script, AUTHOR_LOWERED_FLOW).unwrap();
    let doc = d.join("lowered.paged");
    ok(paged(&["script", s(&blank), s(&script), "-o", s(&doc)]));
    std::fs::write(d.join("products.csv"), "name,price\nAda,10\nGrace,20\n").unwrap();

    let first = d.join("first.paged");
    let applied = apply_lowered(&d, &doc, "0", &first);
    let flow = row(&applied, "flow");
    assert_eq!(flow["outcome"], "written", "{flow:#}");
    assert_eq!(flow["value"]["frames"], 1, "{flow:#}");
    assert_eq!(flow["message"], "replaced 1 frame(s) of the previous flow");
    assert_eq!(flow_frames(&first).len(), 1);
    // The binding moved to the new frame with the stamp: it is still there
    // to apply again, and it is hosted by the frame the flow placed.
    let bindings: Value =
        serde_json::from_str(&ok(paged(&["data", "bindings", s(&first), "--json"]))).unwrap();
    assert_eq!(
        bindings["bindings"][0]["host"], flow["targets"][0],
        "{bindings:#}"
    );
    let second = d.join("second.paged");
    let applied = apply_lowered(&d, &first, "0", &second);
    let flow = row(&applied, "flow");
    assert_eq!(flow["outcome"], "written", "{flow:#}");
    assert_eq!(flow_frames(&second).len(), 1);
}

// ── Remote images on consent (core ADR 1014, amendment 5)

type Requests = std::sync::Arc<std::sync::Mutex<Vec<String>>>;

/// A tiny HTTP/1.1 server on 127.0.0.1 (an ephemeral port, no real
/// network): each request's head is logged, and `route` answers its path
/// with a status, extra header lines and a body.
fn serve(route: impl Fn(&str) -> (u16, String, Vec<u8>) + Send + 'static) -> (u16, Requests) {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let log: Requests = Default::default();
    let seen = log.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let mut head = Vec::new();
            let mut chunk = [0u8; 1024];
            while !head.windows(4).any(|w| w == b"\r\n\r\n") {
                match stream.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => head.extend_from_slice(&chunk[..n]),
                }
            }
            let head = String::from_utf8_lossy(&head).to_string();
            let path = head.split_whitespace().nth(1).unwrap_or("/").to_string();
            seen.lock().unwrap().push(head);
            let (status, extra, body) = route(&path);
            let reply = format!(
                "HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\n{extra}\r\n",
                body.len()
            );
            let _ = stream.write_all(reply.as_bytes());
            let _ = stream.write_all(&body);
        }
    });
    (port, log)
}

/// The lowered document with its `remote` column naming `url`, applied at
/// record 0 to `out` with `extra` arguments and environment.
fn apply_remote(
    d: &Path,
    url: &str,
    extra: &[&str],
    env: &[(&str, &str)],
    out: &Path,
) -> Vec<Value> {
    let doc = lowered_document(d);
    std::fs::write(
        d.join("products.csv"),
        format!(
            "name,price,shown,colour,photo,ean,remote,stock\n\
             Ada,10,true,#ff0000,red.png,4006381333931,{url},asset:logo-a\n"
        ),
    )
    .unwrap();
    let csv = format!("products={}", s(&d.join("products.csv")));
    let mut args = vec!["data", "apply", s(&doc), "--source", &csv];
    args.extend_from_slice(extra);
    args.extend_from_slice(&["-o", s(out), "--json"]);
    let mut command = Command::new(env!("CARGO_BIN_EXE_paged"));
    command.args(&args);
    for (k, v) in env {
        command.env(k, v);
    }
    let report: Value = serde_json::from_str(&ok(command.output().unwrap())).unwrap();
    report["applied"].as_array().unwrap().clone()
}

#[test]
fn data_apply_leaves_a_remote_image_unfetched_without_its_origin_and_names_the_flag__feat__data_bind_labels_native(
) {
    let d = dir("remote-unlisted");
    let (port, log) = serve(|_| (200, String::new(), red_png(3, 4)));
    let url = format!("http://127.0.0.1:{port}/a.png");
    let applied = apply_remote(&d, &url, &[], &[], &d.join("out.paged"));
    let remote = row(&applied, "remote");
    assert_eq!(remote["outcome"], "notHeadless", "{remote:#}");
    let message = remote["message"].as_str().unwrap();
    assert!(
        message.contains(&format!("--allow-origin http://127.0.0.1:{port}")),
        "{message}"
    );
    // An origin listed for another port is not this origin.
    let other = format!("http://127.0.0.1:{}", port.wrapping_add(1));
    let applied = apply_remote(
        &d,
        &url,
        &["--allow-origin", &other],
        &[],
        &d.join("out.paged"),
    );
    assert_eq!(row(&applied, "remote")["outcome"], "notHeadless");
    assert!(log.lock().unwrap().is_empty(), "the server was asked");
}

#[test]
fn data_apply_places_a_remote_image_from_a_listed_origin__feat__data_bind_labels_native() {
    let d = dir("remote-listed");
    let (port, log) = serve(|path| match path {
        "/a.png" => (200, "Content-Type: image/png\r\n".into(), red_png(3, 4)),
        _ => (404, String::new(), Vec::new()),
    });
    let url = format!("http://127.0.0.1:{port}/a.png");
    let origin = format!("HTTP://127.0.0.1:{port}/");
    let saved = d.join("placed.idml");
    let applied = apply_remote(&d, &url, &["--allow-origin", &origin], &[], &saved);
    let remote = row(&applied, "remote");
    assert_eq!(remote["outcome"], "written", "{remote:#}");
    assert_eq!(remote["value"]["image"], url.as_str(), "{remote:#}");
    let frame = remote["targets"][0].as_str().unwrap();
    let id = frame.split_once(':').unwrap().1;
    let spreads = idml_parts(&saved, "Spreads/");
    assert!(
        spreads.contains(&format!("<Image Self=\"{id}Image\"")),
        "{spreads}"
    );
    let log = log.lock().unwrap();
    assert_eq!(log.len(), 1, "{log:#?}");
    let head = log[0].to_ascii_lowercase();
    assert!(
        head.contains(&format!("user-agent: paged/{}", env!("CARGO_PKG_VERSION"))),
        "{head}"
    );
    assert!(
        !head.contains("cookie") && !head.contains("authorization"),
        "{head}"
    );
}

#[test]
fn data_apply_refuses_a_redirect_to_an_unlisted_origin__feat__data_bind_labels_native() {
    let d = dir("remote-redirect");
    let (elsewhere, elsewhere_log) = serve(|_| (200, String::new(), red_png(3, 4)));
    let (port, _) = serve(move |path| match path {
        // Same origin first (followed), then away (refused).
        "/a.png" => (302, "Location: /b.png\r\n".into(), Vec::new()),
        _ => (
            302,
            format!("Location: http://127.0.0.1:{elsewhere}/b.png\r\n"),
            Vec::new(),
        ),
    });
    let url = format!("http://127.0.0.1:{port}/a.png");
    let origin = format!("http://127.0.0.1:{port}");
    let applied = apply_remote(
        &d,
        &url,
        &["--allow-origin", &origin],
        &[],
        &d.join("out.paged"),
    );
    let remote = row(&applied, "remote");
    assert_eq!(remote["outcome"], "failed", "{remote:#}");
    let message = remote["message"].as_str().unwrap();
    assert!(
        message.contains(&format!(
            "the origin http://127.0.0.1:{elsewhere} is not listed"
        )),
        "{message}"
    );
    assert!(
        elsewhere_log.lock().unwrap().is_empty(),
        "the unlisted origin was asked"
    );
}

#[test]
fn data_apply_aborts_a_remote_image_past_the_size_cap__feat__data_bind_labels_native() {
    let d = dir("remote-oversized");
    let (port, _) = serve(|_| (200, String::new(), vec![0u8; 4096]));
    let url = format!("http://127.0.0.1:{port}/big.png");
    let origin = format!("http://127.0.0.1:{port}");
    let applied = apply_remote(
        &d,
        &url,
        &["--allow-origin", &origin],
        &[("PAGED_FETCH_MAX_BYTES", "1000")],
        &d.join("out.paged"),
    );
    let remote = row(&applied, "remote");
    assert_eq!(remote["outcome"], "failed", "{remote:#}");
    assert!(
        remote["message"]
            .as_str()
            .unwrap()
            .contains("1000-byte cap"),
        "{remote:#}"
    );
}

#[test]
fn data_apply_follows_at_most_three_redirects__feat__data_bind_labels_native() {
    let d = dir("remote-redirect-loop");
    let (port, log) = serve(|_| (302, "Location: /again.png\r\n".into(), Vec::new()));
    let url = format!("http://127.0.0.1:{port}/a.png");
    let origin = format!("http://127.0.0.1:{port}");
    let applied = apply_remote(
        &d,
        &url,
        &["--allow-origin", &origin],
        &[],
        &d.join("out.paged"),
    );
    let remote = row(&applied, "remote");
    assert_eq!(remote["outcome"], "failed", "{remote:#}");
    assert!(
        remote["message"]
            .as_str()
            .unwrap()
            .contains("more than 3 redirects"),
        "{remote:#}"
    );
    // The first request and three redirects followed.
    assert_eq!(log.lock().unwrap().len(), 4);
}
