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

//! Every corpus deck reads into the IR (M0 acceptance).
//!
//! The corpus is the private `paged-media/corpus` checkout beside this repo
//! (`../../corpus/pptx/packs/*/primary.pptx`) or `PAGED_CORPUS`. Without it
//! the test skips and says so; `PAGED_REQUIRE_CORPUS=1` turns the skip into a
//! failure, so a CI lane that is meant to read the corpus cannot pass by not
//! looking.

use std::path::PathBuf;

use pptx_core::{FrameContent, Shape};

fn corpus_dir() -> Option<PathBuf> {
    let base = std::env::var_os("PAGED_CORPUS")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../corpus"));
    let dir = base.join("pptx/packs");
    dir.is_dir().then_some(dir)
}

fn decks() -> Vec<PathBuf> {
    let Some(dir) = corpus_dir() else {
        if std::env::var("PAGED_REQUIRE_CORPUS").as_deref() == Ok("1") {
            panic!("PAGED_REQUIRE_CORPUS=1 but no corpus at PAGED_CORPUS or ../../corpus");
        }
        eprintln!("SKIP: no pptx corpus");
        return Vec::new();
    };
    let mut out: Vec<PathBuf> = std::fs::read_dir(dir)
        .unwrap()
        .filter_map(|e| {
            let p = e.ok()?.path().join("primary.pptx");
            p.is_file().then_some(p)
        })
        .collect();
    out.sort();
    out
}

fn count(shapes: &[Shape], n: &mut [usize; 6]) {
    for s in shapes {
        match s {
            Shape::Sp(_) => n[0] += 1,
            Shape::Pic(_) => n[1] += 1,
            Shape::Group(g) => {
                n[2] += 1;
                count(&g.children, n);
            }
            Shape::Connector(_) => n[3] += 1,
            Shape::Frame(f) => {
                n[4] += 1;
                if matches!(f.content, FrameContent::Table(_)) {
                    n[5] += 1;
                }
            }
            Shape::Unknown { .. } => {}
        }
    }
}

#[test]
fn every_corpus_deck_reads() {
    let decks = decks();
    for path in &decks {
        let bytes = std::fs::read(path).unwrap();
        let deck =
            pptx_import::import_pptx(&bytes).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        let name = path
            .parent()
            .unwrap()
            .file_name()
            .unwrap()
            .to_string_lossy();
        assert!(!deck.slides.is_empty(), "{name}: no slides");
        assert!(!deck.masters.is_empty(), "{name}: no masters");
        assert!(!deck.themes.is_empty(), "{name}: no theme");
        for s in &deck.slides {
            let lp = s
                .layout_part
                .as_deref()
                .unwrap_or_else(|| panic!("{name}: {} has no layout", s.part));
            assert!(
                deck.layout(lp).is_some(),
                "{name}: {} names an unread layout {lp}",
                s.part
            );
        }
        let mut n = [0usize; 6];
        for s in &deck.slides {
            count(&s.shapes, &mut n);
        }
        eprintln!(
            "{name}: {} slides, {} layouts, {} masters; sp {} pic {} grp {} cxn {} frame {} (tables {}); notes {}; {} diagnostics",
            deck.slides.len(),
            deck.layouts.len(),
            deck.masters.len(),
            n[0], n[1], n[2], n[3], n[4], n[5],
            deck.slides.iter().filter(|s| s.notes.is_some()).count(),
            deck.diagnostics.len(),
        );
    }
    if corpus_dir().is_some() {
        assert!(
            decks.len() >= 7,
            "expected at least 7 corpus decks, found {}",
            decks.len()
        );
    }
}
