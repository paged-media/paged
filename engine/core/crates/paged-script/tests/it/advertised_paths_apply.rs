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

//! `settablePaths` means SETTABLE.
//!
//! The catalog's advertised list is a published promise: docs.paged.media
//! prints it, the plugin SDK vendors it, and `paged.set` resolves against
//! it. Nothing checked that the apply layer had ever heard of the paths on
//! it — and two had not. `tableRowCount` and `tableColumnCount` are
//! READ-ONLY by contract (`SetProperty` carrying either is rejected;
//! structure edits go through the dedicated row/column operations), and
//! they sat in `settablePaths` regardless, so every consumer of the
//! catalog advertised a write the engine refuses.
//!
//! This is the cheap, structural half of that question: a path the apply
//! layer never NAMES cannot possibly apply. It does not prove the arms are
//! correct — `catalog_apply_parity.rs` probes a sample of those for real —
//! but it makes the empty case impossible, and the empty case is the one
//! that reaches users as "why does `paged.set` return false".

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

/// Every `.rs` under `paged-mutate/src/apply`, concatenated. The apply
/// layer is split across a dozen files by node kind, so a fixed list here
/// would be its own drift.
fn apply_layer_source() -> String {
    fn walk(dir: &Path, out: &mut String) {
        let entries = std::fs::read_dir(dir).unwrap_or_else(|e| panic!("read {dir:?}: {e}"));
        for entry in entries {
            let path = entry.expect("dir entry").path();
            if path.is_dir() {
                walk(&path, out);
            } else if path.extension().and_then(|e| e.to_str()) == Some("rs") {
                out.push_str(&std::fs::read_to_string(&path).expect("read source"));
            }
        }
    }
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../paged-mutate/src/apply");
    let mut out = String::new();
    walk(&dir, &mut out);
    assert!(
        out.len() > 100_000,
        "only {} bytes of apply source found — the walk is broken, not the engine",
        out.len()
    );
    out
}

#[test]
fn every_advertised_path_is_named_by_the_apply_layer() {
    let source = apply_layer_source();
    let catalog = paged_script::api_catalog();
    assert!(
        catalog.settable_paths.len() > 150,
        "the advertised roster came back with {} paths",
        catalog.settable_paths.len()
    );

    // name → variant, through the same lookup `paged.set` uses.
    let unapplied: BTreeSet<&str> = catalog
        .settable_paths
        .iter()
        .filter(|name| {
            let Some(path) = paged_introspect::lookup_path(name) else {
                return true; // advertised and unresolvable is worse still
            };
            let variant = paged_introspect::catalog::variant_name(path);
            !source.contains(&format!("PropertyPath::{variant}"))
        })
        .copied()
        .collect();

    assert!(
        unapplied.is_empty(),
        "these paths are advertised as settable and the apply layer has never \
         heard of them, so `paged.set` can only ever return false: {unapplied:?}"
    );
}
