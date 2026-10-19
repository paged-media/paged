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

//! Goldens of `paged read`: the group and each of its diagnostic
//! questions, asked of the seeded document (`golden::SEED`).
//!
//! Every read prints the engine's reply envelope; the golden holds it,
//! canonicalised. Where a reply lists every property path the engine
//! models (`element-properties`, `style-properties`) or every glyph's
//! outline (`text-outlines`), the golden holds a summary the test derives
//! from it, so a new property path or a font hinting change does not
//! churn a CLI golden; the test asserts the parts that are the CLI's.

use paged_test_resources::covers;
use serde_json::Value;

use crate::golden::{inter, Fx};

/// `paged read <sub>` with no arguments (exit 2), and with the document
/// missing (exit 1): the two errors every read shares.
fn shared_errors(fx: &Fx, sub: &str, rest: &[&str]) {
    let command = format!("paged read {sub}");
    fx.help(&command);
    fx.run(&["read", sub])
        .code(2)
        .golden(&command, "usage-no-args");
    let mut args = vec!["read", sub, "missing.paged"];
    args.extend_from_slice(rest);
    fx.run(&args).code(1).golden(&command, "input-missing-doc");
}

fn seeded(tag: &str) -> Fx {
    let fx = Fx::new(tag);
    fx.seeded("doc.paged");
    fx
}

#[test]
fn read() {
    covers!("cli:paged read");
    let fx = Fx::new("read");
    fx.help("paged read");
    fx.run(&["read"])
        .code(2)
        .golden("paged read", "usage-no-subcommand");
    fx.run(&["read", "nope", "doc.paged"])
        .code(2)
        .golden("paged read", "usage-unknown-question");
}

#[test]
fn layers() {
    covers!("cli:paged read layers");
    let fx = seeded("read-layers");
    shared_errors(&fx, "layers", &[]);
    fx.run(&["read", "layers", "doc.paged"])
        .code(0)
        .golden("paged read layers", "seeded");
    let compact = fx
        .run(&["read", "layers", "doc.paged", "--compact"])
        .code(0);
    assert_eq!(compact.stdout.lines().count(), 1, "--compact is one line");
    assert_eq!(compact.json()["payload"]["items"][0]["name"], "Art");
}

#[test]
fn collection() {
    covers!("cli:paged read collection");
    let fx = seeded("read-collection");
    shared_errors(&fx, "collection", &["swatches"]);
    fx.run(&["read", "collection", "doc.paged", "nope"])
        .code(1)
        .golden("paged read collection", "input-unknown-collection");
    fx.run(&["read", "collection", "doc.paged", "swatches"])
        .code(0)
        .golden("paged read collection", "swatches");
    fx.run(&["read", "collection", "doc.paged", "gradients"])
        .code(0)
        .golden("paged read collection", "gradients");
}

#[test]
fn frame_chain() {
    covers!("cli:paged read frame-chain");
    let fx = seeded("read-frame-chain");
    shared_errors(&fx, "frame-chain", &["Story/u0"]);
    fx.run(&["read", "frame-chain", "doc.paged", "Story/u0"])
        .code(0)
        .golden("paged read frame-chain", "one-frame");
    fx.run(&["read", "frame-chain", "doc.paged", "Story/nope"])
        .code(0)
        .golden("paged read frame-chain", "unknown-story-is-empty");
}

#[test]
fn story_content() {
    covers!("cli:paged read story-content");
    let fx = seeded("read-story-content");
    shared_errors(&fx, "story-content", &["Story/u0"]);
    let r = fx
        .run(&["read", "story-content", "doc.paged", "Story/u0"])
        .code(0);
    assert_eq!(
        r.json()["payload"]["content"]["paragraphs"][0]["runs"][0]["text"],
        "Hello world"
    );
    r.golden("paged read story-content", "hello-world");
    fx.run(&["read", "story-content", "doc.paged", "Story/nope"])
        .code(0)
        .golden("paged read story-content", "unknown-story-is-null");
}

#[test]
fn style_properties() {
    covers!("cli:paged read style-properties");
    let fx = seeded("read-style-properties");
    let style = "ParagraphStyle/$ID/[No paragraph style]";
    shared_errors(&fx, "style-properties", &["paragraph", style]);
    fx.run(&["read", "style-properties", "doc.paged", "nope", "x"])
        .code(1)
        .golden("paged read style-properties", "input-unknown-collection");
    let r = fx
        .run(&["read", "style-properties", "doc.paged", "paragraph", style])
        .code(0);
    let entries = r.json()["payload"]["result"]["entries"]
        .as_array()
        .map(Vec::len)
        .unwrap_or(0);
    assert!(entries > 20, "the style's property rows: {entries}");
    r.map_stdout(summarise_entries)
        .golden("paged read style-properties", "basic-paragraph");
}

#[test]
fn placeholders() {
    covers!("cli:paged read placeholders");
    let fx = seeded("read-placeholders");
    shared_errors(&fx, "placeholders", &[]);
    fx.run(&["read", "placeholders", "doc.paged"])
        .code(0)
        .golden("paged read placeholders", "none");
}

#[test]
fn color_preview() {
    covers!("cli:paged read color-preview");
    let fx = seeded("read-color-preview");
    shared_errors(&fx, "color-preview", &["Color/u1"]);
    fx.run(&["read", "color-preview", "doc.paged", "Color/u1"])
        .code(0)
        .golden("paged read color-preview", "vermilion");
    fx.run(&["read", "color-preview", "doc.paged", "Color/nope"])
        .code(0)
        .golden("paged read color-preview", "unknown-swatch-is-null");
}

#[test]
fn color_compute() {
    covers!("cli:paged read color-compute");
    let fx = seeded("read-color-compute");
    fx.help("paged read color-compute");
    fx.run(&["read", "color-compute", "doc.paged", "CMYK"])
        .code(2)
        .golden("paged read color-compute", "usage-no-value");
    fx.run(&["read", "color-compute"])
        .code(2)
        .golden("paged read color-compute", "usage-no-args");
    fx.run(&[
        "read",
        "color-compute",
        "missing.paged",
        "CMYK",
        "--value",
        "0",
    ])
    .code(1)
    .golden("paged read color-compute", "input-missing-doc");
    fx.run(&["read", "color-compute", "doc.paged", "CMYK", "--value", "x"])
        .code(2)
        .golden("paged read color-compute", "usage-value-not-a-number");
    let red = [
        "read",
        "color-compute",
        "doc.paged",
        "CMYK",
        "--value",
        "0",
        "--value",
        "100",
        "--value",
        "100",
        "--value",
        "0",
    ];
    fx.run(&red)
        .code(0)
        .golden("paged read color-compute", "cmyk-red");
    fx.run(&[
        "read",
        "color-compute",
        "doc.paged",
        "RGB",
        "--value",
        "0",
        "--value",
        "0",
        "--value",
        "255",
    ])
    .code(0)
    .golden("paged read color-compute", "rgb-blue");
}

#[test]
fn gradient_detail() {
    covers!("cli:paged read gradient-detail");
    let fx = seeded("read-gradient-detail");
    shared_errors(&fx, "gradient-detail", &["Gradient/u0"]);
    fx.run(&["read", "gradient-detail", "doc.paged", "Gradient/u0"])
        .code(0)
        .golden("paged read gradient-detail", "dawn");
    fx.run(&["read", "gradient-detail", "doc.paged", "Gradient/nope"])
        .code(0)
        .golden("paged read gradient-detail", "unknown-gradient-is-null");
}

/// `{result: {id, kind, name, entries: [...]}}` → the id, the kind, the
/// row count's presence and the rows that carry a value.
fn summarise_entries(stdout: &str) -> String {
    let v: Value = serde_json::from_str(stdout).expect("JSON");
    let result = &v["payload"]["result"];
    let entries = result["entries"].as_array().cloned().unwrap_or_default();
    let set: Vec<&Value> = entries
        .iter()
        .filter(|e| {
            let value = &e["value"]["value"];
            !(value.is_null() || value == "" || value == &Value::Array(vec![]))
        })
        .collect();
    let mut head = result.clone();
    if let Some(obj) = head.as_object_mut() {
        obj.remove("entries");
    }
    format!(
        "kind: {}\nresult (without entries): {}\nentries: <{} rows>\nrows with a value: {}\n",
        v["kind"],
        serde_json::to_string(&crate::golden::canonical(&head, None)).unwrap(),
        if entries.is_empty() { "no" } else { "some" },
        serde_json::to_string_pretty(&crate::golden::canonical(
            &Value::Array(set.into_iter().cloned().collect()),
            None
        ))
        .unwrap()
    )
}

#[test]
fn element_properties() {
    covers!("cli:paged read element-properties");
    let fx = seeded("read-element-properties");
    shared_errors(&fx, "element-properties", &["oval:u2"]);
    fx.run(&["read", "element-properties", "doc.paged", "garbage"])
        .code(1)
        .golden("paged read element-properties", "input-not-an-address");
    let r = fx
        .run(&["read", "element-properties", "doc.paged", "rectangle:u5"])
        .code(0);
    assert_eq!(r.json()["payload"]["result"]["kind"], "Rectangle");
    r.map_stdout(summarise_entries)
        .golden("paged read element-properties", "rectangle");
    fx.run(&["read", "element-properties", "doc.paged", "oval:nope"])
        .code(0)
        .golden("paged read element-properties", "unknown-element-is-null");
}

#[test]
fn element_geometry() {
    covers!("cli:paged read element-geometry");
    let fx = seeded("read-element-geometry");
    shared_errors(&fx, "element-geometry", &["oval:u2"]);
    fx.run(&[
        "read",
        "element-geometry",
        "doc.paged",
        "oval:u2",
        "oval:u3",
    ])
    .code(0)
    .golden("paged read element-geometry", "two-ovals");
    fx.run(&["read", "element-geometry", "doc.paged", "oval:nope"])
        .code(0)
        .golden("paged read element-geometry", "unknown-element-is-empty");
}

#[test]
fn snippet() {
    covers!("cli:paged read snippet");
    let fx = seeded("read-snippet");
    shared_errors(&fx, "snippet", &["oval:u2"]);
    let r = fx
        .run(&["read", "snippet", "doc.paged", "oval:u2", "oval:u3"])
        .code(0);
    assert_eq!(r.json()["kind"], "elementsExported");
    assert_eq!(r.json()["payload"]["count"], 2);
    r.golden("paged read snippet", "two-ovals");
    fx.run(&["read", "snippet", "doc.paged", "oval:nope"])
        .code(0)
        .golden("paged read snippet", "unknown-element-is-refused");
}

#[test]
fn group_leaves() {
    covers!("cli:paged read group-leaves");
    let fx = seeded("read-group-leaves");
    shared_errors(&fx, "group-leaves", &["group:u9"]);
    fx.write("group.js", "paged.createGroup(['oval:u2', 'oval:u3']);");
    fx.run(&["script", "doc.paged", "group.js", "-o", "grouped.paged"])
        .code(0);
    let group = fx.run(&["query", "grouped.paged", "group"]).code(0);
    let id = group.stdout.trim().to_string();
    assert!(id.starts_with("group:"), "one group: {id}");
    fx.run(&["read", "group-leaves", "grouped.paged", &id])
        .code(0)
        .golden("paged read group-leaves", "two-leaves");
    fx.run(&["read", "group-leaves", "doc.paged", "group:nope"])
        .code(0)
        .golden("paged read group-leaves", "unknown-group-is-empty");
}

#[test]
fn path_anchors() {
    covers!("cli:paged read path-anchors");
    let fx = seeded("read-path-anchors");
    shared_errors(&fx, "path-anchors", &["polygon:u4"]);
    fx.run(&["read", "path-anchors", "doc.paged", "polygon:u4"])
        .code(0)
        .golden("paged read path-anchors", "open-path");
    fx.run(&["read", "path-anchors", "doc.paged", "nope"])
        .code(1)
        .golden("paged read path-anchors", "input-not-an-address");
}

#[test]
fn text_outlines() {
    covers!("cli:paged read text-outlines");
    let fx = seeded("read-text-outlines");
    shared_errors(&fx, "text-outlines", &["textFrame:u1"]);
    let r = fx
        .run(&["read", "text-outlines", "doc.paged", "textFrame:u1"])
        .code(0);
    let runs = r.json()["payload"]["result"]["runs"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    assert!(!runs.is_empty(), "the shaped text has outlines");
    let anchors: usize = runs
        .iter()
        .map(|run| run["anchors"].as_array().map(Vec::len).unwrap_or(0))
        .sum();
    assert!(
        anchors > 40,
        "eleven glyphs make more than 40 anchors: {anchors}"
    );
    r.map_stdout(|s| {
        let v: Value = serde_json::from_str(s).unwrap();
        let result = &v["payload"]["result"];
        let run_keys: Vec<String> = result["runs"][0]
            .as_object()
            .map(|o| o.keys().cloned().collect())
            .unwrap_or_default();
        format!(
            "kind: {}\nid: {}\npageId: {}\nruns: <some>, each with keys {run_keys:?}\nfirst run rgb: {}\n",
            v["kind"], result["id"], result["pageId"], result["runs"][0]["rgb"]
        )
    })
    .golden("paged read text-outlines", "hello-world");
    fx.run(&["read", "text-outlines", "doc.paged", "oval:nope"])
        .code(0)
        .golden("paged read text-outlines", "unknown-element-is-null");
}

#[test]
fn snap_point() {
    covers!("cli:paged read snap-point");
    let fx = seeded("read-snap-point");
    shared_errors(&fx, "snap-point", &["usp", "100", "100"]);
    fx.run(&["read", "snap-point", "doc.paged", "usp", "1", "2", "3"])
        .code(2)
        .golden("paged read snap-point", "usage-three-coordinates");
    fx.run(&["read", "snap-point", "doc.paged", "usp", "401", "99"])
        .code(0)
        .golden("paged read snap-point", "near-a-frame-corner");
    // Negative coordinates are values, not flags.
    fx.run(&[
        "read",
        "snap-point",
        "--compact",
        "doc.paged",
        "usp",
        "-5",
        "-5",
    ])
    .code(0)
    .golden("paged read snap-point", "negative-point");
    fx.run(&[
        "read",
        "snap-point",
        "--grid",
        "--compact",
        "doc.paged",
        "usp",
        "13",
        "13",
    ])
    .code(0)
    .golden("paged read snap-point", "grid");
}

/// CLI-7 (fixed): the point's coordinates take negative numbers, not
/// any hyphen value, so a flag written after the point is a flag, as in
/// every other command.
#[test]
fn snap_point_takes_a_trailing_flag() {
    covers!("cli:paged read snap-point");
    let fx = seeded("read-snap-point-flag");
    fx.run(&[
        "read",
        "snap-point",
        "doc.paged",
        "usp",
        "13",
        "13",
        "--grid",
    ])
    .code(0)
    .golden("paged read snap-point", "trailing-flag");
}

/// CLI-4 (fixed): `paged read snap-point <doc> <page>` with no point is a
/// usage error naming the missing `X` and `Y`, not a panic.
#[test]
fn snap_point_without_a_point_is_a_usage_error() {
    covers!("cli:paged read snap-point");
    let fx = seeded("read-snap-point-no-point");
    let r = fx
        .run(&["read", "snap-point", "doc.paged", "usp"])
        .code(2)
        .golden("paged read snap-point", "usage-no-point");
    assert!(r.stderr.contains("<X>") && r.stderr.contains("<Y>"), "{}", r.stderr);
}

#[test]
fn planar_regions() {
    covers!("cli:paged read planar-regions");
    let fx = seeded("read-planar-regions");
    shared_errors(&fx, "planar-regions", &["oval:u2"]);
    let r = fx
        .run(&["read", "planar-regions", "doc.paged", "oval:u2", "oval:u3"])
        .code(0);
    let faces = r.json()["payload"]["result"]["faces"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    // Two overlapping ovals: each alone, and the lens they share.
    let signatures: Vec<String> = faces.iter().map(|f| f["signature"].to_string()).collect();
    assert_eq!(signatures.len(), 3, "{signatures:?}");
    assert!(signatures.contains(&"[0,1]".to_string()), "{signatures:?}");
    r.map_stdout(|s| {
        let v: Value = serde_json::from_str(s).unwrap();
        let result = &v["payload"]["result"];
        let faces: Vec<String> = result["faces"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| {
                format!(
                    "{} signature {} area ~{}",
                    f["id"],
                    f["signature"],
                    f["area"]
                        .as_f64()
                        .map(|a| (a / 10.0).round() * 10.0)
                        .unwrap_or(-1.0)
                )
            })
            .collect();
        format!(
            "kind: {}\nfound: {} complete: {} inputCount: {}\nfaces:\n{}\n",
            v["kind"],
            result["found"],
            result["complete"],
            result["inputCount"],
            faces.join("\n")
        )
    })
    .golden("paged read planar-regions", "two-ovals");
    fx.run(&["read", "planar-regions", "doc.paged", "oval:nope"])
        .code(0)
        .golden("paged read planar-regions", "unknown-element-not-found");
}

#[test]
fn measure_text() {
    covers!("cli:paged read measure-text");
    let fx = seeded("read-measure-text");
    shared_errors(&fx, "measure-text", &["Inter", "Hello"]);
    fx.run(&[
        "read",
        "measure-text",
        "doc.paged",
        "Inter",
        "Hello",
        "--fonts",
        &inter(),
    ])
    .code(0)
    .golden("paged read measure-text", "inter-hello");
    fx.run(&[
        "read",
        "measure-text",
        "doc.paged",
        "Inter",
        "Hello",
        "--size-pt",
        "24",
        "--fonts",
        &inter(),
    ])
    .code(0)
    .golden("paged read measure-text", "inter-hello-24pt");
}

/// `paged read placed-asset` takes the frame's bare `Self` id (`u5`) or
/// the `kind:id` address every other element argument takes
/// (`rectangle:u5`; finding CLI-2, fixed: the address once answered
/// `found: false`).
#[test]
fn placed_asset() {
    covers!("cli:paged read placed-asset");
    let fx = Fx::new("read-placed-asset");
    fx.placed("doc.paged");
    shared_errors(&fx, "placed-asset", &["u5"]);
    fx.run(&["read", "placed-asset", "doc.paged", "u5", "-o", "asset.png"])
        .code(0)
        .golden("paged read placed-asset", "inline-image");
    assert_eq!(
        fx.read("asset.png"),
        fx.read("placed-image.png"),
        "the bytes placed come back"
    );
    fx.run(&[
        "read",
        "placed-asset",
        "doc.paged",
        "rectangle:u4",
        "-o",
        "none.png",
    ])
    .code(1)
    .golden("paged read placed-asset", "input-nothing-to-write");
    assert!(
        !fx.exists("none.png"),
        "a read that finds nothing writes no file"
    );
    let addressed = fx
        .run(&["read", "placed-asset", "doc.paged", "rectangle:u5"])
        .golden("paged read placed-asset", "address-form");
    assert_eq!(addressed.code, Some(0));
    assert_eq!(addressed.json()["payload"]["found"], true);
}

#[test]
fn font_face() {
    covers!("cli:paged read font-face");
    let fx = seeded("read-font-face");
    shared_errors(&fx, "font-face", &["Inter"]);
    fx.run(&["read", "font-face", "doc.paged", "Inter", "-o", "none.ttf"])
        .code(1)
        .golden("paged read font-face", "input-family-not-registered");
    assert!(!fx.exists("none.ttf"));
    fx.run(&[
        "read",
        "font-face",
        "doc.paged",
        "Inter",
        "-o",
        "inter.ttf",
        "--fonts",
        &inter(),
    ])
    .code(0)
    .golden("paged read font-face", "inter");
    assert_eq!(
        fx.read("inter.ttf"),
        std::fs::read(inter()).unwrap(),
        "the registered face comes back byte for byte"
    );
}

#[test]
fn swatch_library() {
    covers!("cli:paged read swatch-library");
    let fx = seeded("read-swatch-library");
    fx.help("paged read swatch-library");
    fx.run(&["read", "swatch-library", "doc.paged"])
        .code(2)
        .golden("paged read swatch-library", "usage-no-out");
    fx.run(&["read", "swatch-library"])
        .code(2)
        .golden("paged read swatch-library", "usage-no-args");
    fx.run(&["read", "swatch-library", "missing.paged", "-o", "x.ase"])
        .code(1)
        .golden("paged read swatch-library", "input-missing-doc");
    fx.run(&["read", "swatch-library", "doc.paged", "-o", "swatches.ase"])
        .code(0)
        .golden("paged read swatch-library", "ase");
    assert!(
        fx.read("swatches.ase").starts_with(b"ASEF"),
        "an Adobe Swatch Exchange file"
    );
}
