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

//! `paged export --tagged` / `--bookmarks` reach the PDF writer: the
//! flags were wire options with no CLI spelling.

use std::path::PathBuf;
use std::process::Command;

fn export(stem: &str, flags: &[&str]) -> Vec<u8> {
    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let out = std::env::temp_dir().join(format!(
        "paged-pdf-flags-{stem}-{}-{}.pdf",
        flags.len(),
        std::process::id()
    ));
    let run = Command::new(env!("CARGO_BIN_EXE_paged"))
        .arg("export")
        .arg(repo.join(format!("corpus/generated/{stem}.idml")))
        .args(["--format", "pdf", "-o", out.to_str().unwrap()])
        .args(flags)
        .output()
        .expect("run paged export");
    assert!(
        run.status.success(),
        "{}",
        String::from_utf8_lossy(&run.stderr)
    );
    std::fs::read(&out).expect("pdf written")
}

fn has(pdf: &[u8], needle: &str) -> bool {
    pdf.windows(needle.len()).any(|w| w == needle.as_bytes())
}

#[test]
fn tagged_flag_writes_a_structure_tree() {
    assert!(!has(&export("text", &[]), "/StructTreeRoot"));
    let pdf = export("text", &["--tagged"]);
    assert!(has(&pdf, "/StructTreeRoot"));
    assert!(has(&pdf, "/MarkInfo"));
}

#[test]
fn bookmarks_flag_writes_the_outline() {
    assert!(has(&export("navigation", &["--bookmarks"]), "/Outlines"));
}
