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

//! Shared plumbing for the OPT-IN corpus lanes.
//!
//! The corpus is a private checkout at `<repo root>/corpus` (gitignored; Git
//! LFS, and a 4.4 GB payload that is not even in the repo). Nothing here
//! may hard-fail on a machine that has no copy — CI has none. Every
//! caller is `#[ignore]`d as well, so the corpus lanes run only when
//! asked for:
//!
//! ```text
//! PAGED_IDML_CORPUS=1 cargo test -p idml-export -- --ignored --nocapture
//! ```
//!
//! `PAGED_IDML_CORPUS` may also name the corpus root directly, which is
//! how a checkout somewhere other than the default path is used.
//! Mirrors plugin-image's `PAGED_PSD_ORACLE` lane in shape and posture.

#![allow(dead_code)]

use std::io::Read;
use std::path::PathBuf;

/// The corpus root, or `None` (with a printed reason) when this machine
/// has no usable copy. Callers `return` on `None`.
pub fn root() -> Option<PathBuf> {
    let Some(switch) = std::env::var_os("PAGED_IDML_CORPUS") else {
        eprintln!(
            "SKIP corpus lane: PAGED_IDML_CORPUS unset \
             (set it to 1, or to a corpus root, and run with --ignored)"
        );
        return None;
    };
    let switch = switch.to_string_lossy().into_owned();
    let path = if switch == "1" || switch.is_empty() {
        // The default: the monorepo's <repo root>/corpus (gitignored; a
        // local symlink to the private corpus), four levels above this crate.
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../../corpus")
    } else {
        PathBuf::from(switch)
    };
    if !path.is_dir() {
        eprintln!("SKIP corpus lane: {} is not a directory", path.display());
        return None;
    }
    Some(path)
}

/// A package this lane addresses BY NAME, or a hard failure.
///
/// These lanes name specific packs because that pack is the measured
/// evidence for a specific defect — not a sample that may or may not be
/// present. So once [`root`] has answered, the corpus IS mounted, and a
/// name that does not resolve is a broken lane rather than a machine
/// without a corpus.
///
/// The distinction is not academic: the 2026-08-21 restructure moved
/// `samples/` under `idml/samples/`, and the label lane went on printing
/// `SKIP: … not found` and reporting green for a fixture it never opened.
/// A missing corpus is the corpus's absence; a stale path is ours.
pub fn package(root: &std::path::Path, rel: &str) -> PathBuf {
    let p = root.join(rel);
    assert!(
        p.is_file(),
        "corpus lane addresses {rel}, which this corpus does not have \
         (looked at {}). The path is stale or the asset moved — fix the \
         lane; do not let it skip.",
        p.display()
    );
    p
}

/// Whether `p` opens as a ZIP, i.e. is really an IDML package.
///
/// An IDML is a ZIP, and a sweep that selects `*.idml` by EXTENSION will
/// eventually be handed something that is not one: the corpus is vendor
/// material, and `real-estate-brochure-e20723` shipped its InDesign
/// binary under the name `Real Estate Brochure.idml` (magic `0606edf5`,
/// byte-identical to the `.indd` beside it). That aborted the whole
/// master-spread lane on `InvalidArchive("Could not find EOCD")`.
/// plugin-image met the same class of thing and moved to signature
/// reads; this is that move for the IDML sweeps.
pub fn is_package(p: &std::path::Path) -> bool {
    let mut head = [0u8; 4];
    match std::fs::File::open(p) {
        Ok(mut f) => std::io::Read::read_exact(&mut f, &mut head).is_ok() && &head == b"PK\x03\x04",
        Err(_) => false,
    }
}

/// Every `Spreads/*.xml` entry of an IDML package, as
/// `(entry name, decompressed bytes)`.
pub fn spreads(package: &std::path::Path) -> Vec<(String, Vec<u8>)> {
    entries(package, "Spreads/")
}

/// Every `Stories/*.xml` entry of an IDML package. The story lane is the
/// bulk of a real package — 10,539 of the corpus's 12,668 entries against
/// the spread lane's 823 — so a guard that only walks `spreads()` is
/// measuring 7% of the document.
pub fn stories(package: &std::path::Path) -> Vec<(String, Vec<u8>)> {
    entries(package, "Stories/")
}

/// Every `<prefix>*.xml` entry of an IDML package, as
/// `(entry name, decompressed bytes)`.
pub fn entries(package: &std::path::Path, prefix: &str) -> Vec<(String, Vec<u8>)> {
    let bytes = std::fs::read(package).expect("read package");
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap_or_else(|e| {
        panic!(
            "{} is not a readable IDML package ({e}) — an IDML is a ZIP, so \
             this file is mislabelled in the corpus",
            package.display()
        )
    });
    let names: Vec<String> = (0..zip.len())
        .filter_map(|i| {
            zip.by_index(i)
                .ok()
                .and_then(|e| e.name().ok().map(|n| n.into_owned()))
        })
        .filter(|n| n.starts_with(prefix) && n.ends_with(".xml"))
        .collect();
    names
        .into_iter()
        .map(|name| {
            let mut body = Vec::new();
            zip.by_name(&name)
                .expect("named entry")
                .read_to_end(&mut body)
                .expect("read entry");
            (name, body)
        })
        .collect()
}
