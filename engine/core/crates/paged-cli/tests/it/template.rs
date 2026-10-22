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

//! `paged template` (editor plan F6): fields, a fill as a filler, a refused
//! fill, and a check that passes a clean fill and catches a moved frame.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

fn paged(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_paged"))
        .args(args)
        .output()
        .unwrap()
}

fn s(p: &Path) -> &str {
    p.to_str().unwrap()
}

const AUTHOR: &str = r#"
const parse = (v) => (typeof v === "string" ? JSON.parse(v) : v);
const pages = parse(paged.pages());
const before = new Set(parse(paged.stories()).map((s) => s.selfId));
const frame = paged.insertTextFrame(pages[0].selfId, [72, 72, 200, 300]);
const story = parse(paged.stories()).map((s) => s.selfId).find((s) => !before.has(s));
paged.insertText(story, 0, "Old title");
paged.setPluginMetadata(String(frame), "x-paged:template",
  JSON.stringify({ v: 1, data: { field: { name: "headline", kind: "text", constraints: { maxLength: 20 } } } }));
paged.insertFrame(pages[0].selfId, [300, 72, 360, 200]);
"#;

/// A template: `headline`, a text field of at most 20 characters, beside a
/// frame the template does not open.
fn template(dir: &Path) -> PathBuf {
    let blank = dir.join("blank.paged");
    assert!(paged(&["new", "--size", "a5", "--out", s(&blank)])
        .status
        .success());
    let script = dir.join("author.js");
    std::fs::write(&script, AUTHOR).unwrap();
    let t = dir.join("t.paged");
    let out = paged(&[
        "script",
        s(&blank),
        s(&script),
        "--role",
        "author",
        "-o",
        s(&t),
    ]);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    t
}

#[test]
fn fill_as_a_filler_and_check_the_submission() {
    let dir = std::env::temp_dir().join(format!("paged-template-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let t = template(&dir);

    let fields = paged(&["template", "fields", s(&t), "--json"]);
    assert!(fields.status.success());
    let json: serde_json::Value = serde_json::from_slice(&fields.stdout).unwrap();
    assert_eq!(json["fields"][0]["field"]["name"], "headline");
    assert_eq!(json["fields"][0]["value"]["text"], "Old title");

    let filled = dir.join("filled.paged");
    let out = paged(&[
        "template",
        "fill",
        s(&t),
        "--values",
        r#"{"headline":"Ada Example"}"#,
        "-o",
        s(&filled),
    ]);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let after: serde_json::Value =
        serde_json::from_slice(&paged(&["template", "fields", s(&filled), "--json"]).stdout)
            .unwrap();
    assert_eq!(after["fields"][0]["value"]["text"], "Ada Example");

    // A value longer than the field allows is refused, and nothing is written.
    let refused_out = dir.join("refused.paged");
    let refused = paged(&[
        "template",
        "fill",
        s(&t),
        "--values",
        r#"{"headline":"A title much longer than twenty"}"#,
        "-o",
        s(&refused_out),
    ]);
    assert!(!refused.status.success());
    assert!(String::from_utf8_lossy(&refused.stderr).contains("headline"));
    assert!(!refused_out.exists());

    // The clean fill checks; the same fill with the other frame moved does not.
    let ok = paged(&["template", "check", s(&t), s(&filled)]);
    assert!(
        ok.status.success(),
        "{}",
        String::from_utf8_lossy(&ok.stdout)
    );
    let mover = dir.join("move.js");
    std::fs::write(
        &mover,
        r#"const f = JSON.parse(JSON.stringify(paged.query("rectangle")));
           paged.set(Array.isArray(f) ? f[0] : JSON.parse(f)[0], "frameBounds", [320, 90, 380, 220]);"#,
    )
    .unwrap();
    let tampered = dir.join("tampered.paged");
    let moved = paged(&["script", s(&filled), s(&mover), "-o", s(&tampered)]);
    assert!(
        moved.status.success(),
        "{}",
        String::from_utf8_lossy(&moved.stderr)
    );
    let caught = paged(&["template", "check", s(&t), s(&tampered), "--json"]);
    assert_eq!(
        caught.status.code(),
        Some(1),
        "{}",
        String::from_utf8_lossy(&caught.stdout)
    );
    let _ = std::fs::remove_dir_all(&dir);
}
