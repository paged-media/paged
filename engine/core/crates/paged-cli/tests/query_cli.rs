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

//! `paged query <doc> <selector>` (ADR 131): one canonical address per
//! line, the reply envelope with `--json`, a caret under the offending
//! byte when the selector does not parse.

use std::path::PathBuf;
use std::process::Command;

fn fixture() -> String {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../corpus/generated/geometry-groups.idml")
        .to_string_lossy()
        .into_owned()
}

fn paged(args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_paged"))
        .args(args)
        .output()
        .expect("run paged")
}

#[test]
fn query_prints_one_address_per_line() {
    let doc = fixture();
    let out = paged(&["query", &doc, "textFrame, group"]);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let text = String::from_utf8_lossy(&out.stdout);
    let lines: Vec<&str> = text.lines().collect();
    assert!(lines.contains(&"textFrame:ua365e1"), "{text}");
    assert!(lines.iter().any(|l| l.starts_with("group:")), "{text}");
    assert!(
        lines
            .iter()
            .all(|l| l.starts_with("textFrame:") || l.starts_with("group:")),
        "{text}"
    );
}

#[test]
fn query_json_is_the_engine_reply() {
    let out = paged(&["query", &fixture(), "page:#1", "--json"]);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).expect("json");
    assert_eq!(v["kind"], "queryResult");
    assert_eq!(v["payload"]["addresses"].as_array().map(Vec::len), Some(1));
    assert!(v["payload"]["error"].is_null());
}

#[test]
fn a_malformed_selector_fails_with_a_caret() {
    let out = paged(&["query", &fixture(), "page > sprocket"]);
    assert!(!out.status.success());
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(err.contains("\"sprocket\" is not a kind"), "{err}");
    assert!(err.contains("         ^"), "{err}");
}
