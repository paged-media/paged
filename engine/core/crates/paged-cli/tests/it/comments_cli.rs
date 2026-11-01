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

//! Engine ADR 1055 on the command line: comment threads are written with
//! `paged invoke` and listed with `paged read collection`, with no verb of
//! their own.

use std::path::PathBuf;
use std::process::Command;

fn paged(args: &[&str]) -> String {
    let run = Command::new(env!("CARGO_BIN_EXE_paged"))
        .args(args)
        .output()
        .expect("run paged");
    assert!(
        run.status.success(),
        "paged {args:?}: {}",
        String::from_utf8_lossy(&run.stderr)
    );
    String::from_utf8_lossy(&run.stdout).into_owned()
}

#[test]
fn threads_are_written_by_invoke_and_listed_by_read() {
    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let source = repo.join("corpus/generated/text.idml");
    let dir = std::env::temp_dir().join(format!("paged-comments-cli-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let first = dir.join("one.paged");
    let second = dir.join("two.paged");

    paged(&[
        "invoke",
        source.to_str().unwrap(),
        "insertCommentThread",
        r#"{"anchor":{"kind":"cell","item":"sheet1","address":"Sheet1!B3"},"comment":{"id":"t1","author":"Ann Author","text":"Check this cell"}}"#,
        "-o",
        first.to_str().unwrap(),
    ]);
    paged(&[
        "invoke",
        first.to_str().unwrap(),
        "replyComment",
        r#"{"parentId":"t1","comment":{"id":"t1.1","author":"Bob","text":"Checked"}}"#,
        "-o",
        second.to_str().unwrap(),
    ]);

    let listed = paged(&["read", "collection", second.to_str().unwrap(), "comments"]);
    for expected in ["Check this cell", "Checked", "Sheet1!B3", "Ann Author"] {
        assert!(listed.contains(expected), "{expected} in:\n{listed}");
    }
}

#[test]
fn an_idml_export_names_the_threads_it_cannot_carry() {
    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let source = repo.join("corpus/generated/text.idml");
    let dir = std::env::temp_dir().join(format!("paged-comments-idml-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let with_thread = dir.join("thread.paged");
    paged(&[
        "invoke",
        source.to_str().unwrap(),
        "insertCommentThread",
        r#"{"anchor":{"kind":"cell","item":"sheet1","address":"Sheet1!B3"},"comment":{"id":"t1","author":"Ann Author","text":"Check this cell"}}"#,
        "-o",
        with_thread.to_str().unwrap(),
    ]);
    let out = dir.join("out.idml");
    let run = Command::new(env!("CARGO_BIN_EXE_paged"))
        .args(["export", with_thread.to_str().unwrap()])
        .args(["--format", "idml", "-o", out.to_str().unwrap()])
        .output()
        .expect("run paged export");
    assert!(
        run.status.success(),
        "{}",
        String::from_utf8_lossy(&run.stderr)
    );
    let stderr = String::from_utf8_lossy(&run.stderr);
    assert!(
        stderr.contains("lost in translation to IDML: comment thread `t1`")
            && stderr.contains("on cell `Sheet1!B3` of `sheet1`"),
        "{stderr}"
    );
    assert!(out.exists());
}
