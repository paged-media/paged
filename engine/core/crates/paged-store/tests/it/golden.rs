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

//! The native model part's format, pinned by two committed files per
//! [`paged_store::PGM_FORMAT_VERSION`] (`tests/golden/`):
//!
//! * `document.v<N>.pgm` — a small model part as version N wrote it. It
//!   must still decode, and must re-encode to the same bytes: a field
//!   that was added, dropped, renamed or re-defaulted shows here.
//! * `model-shape.v<N>.txt` — the serialised SHAPE of the same document
//!   (every key path and its JSON type, no values), compared against a
//!   fresh encoding. It says in a readable diff which paths moved.
//!
//! Both fail when the model's serde shape changes while the version stays:
//! the version is what tells an older engine that it cannot read a part
//! (and a newer one which adapter to apply), so a shape change without a
//! bump is a part that mis-reads without a word.
//!
//! ## Regenerating
//!
//! After a shape change, FIRST bump `PGM_FORMAT_VERSION` in `src/lib.rs`
//! (and keep the old version readable, or raise `OLDEST_READABLE_PGM`).
//! Then write the new version's files:
//!
//! ```text
//! PAGED_STORE_GOLDEN=write cargo test -p paged-store golden
//! ```
//!
//! That writes only files that do not exist yet: the files of a version
//! that is already committed are that version's record and stay (an older
//! `document.v<N>.pgm` keeps proving that version still reads). The one
//! reason to rewrite the current version's files is a change to the
//! document THIS FILE builds (`golden_document`) with no model change
//! behind it; that is `PAGED_STORE_GOLDEN=rewrite`.

use std::collections::BTreeMap;
use std::path::PathBuf;

use paged_model::{Bounds, FrameRef, Group, Paragraph, Spread, Story};
use paged_scene::{Document, ParsedSpread, ParsedStory};

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/golden")
}

fn part_path(version: u32) -> PathBuf {
    dir().join(format!("document.v{version}.pgm"))
}

fn shape_path(version: u32) -> PathBuf {
    dir().join(format!("model-shape.v{version}.txt"))
}

/// `write` / `rewrite`, see the module doc.
fn mode() -> Option<String> {
    std::env::var("PAGED_STORE_GOLDEN").ok()
}

const HOW: &str = "the model's serialised shape changed. Bump PGM_FORMAT_VERSION \
                   (paged-store/src/lib.rs), then run \
                   `PAGED_STORE_GOLDEN=write cargo test -p paged-store golden` and commit \
                   the new files in tests/golden; see tests/it/golden.rs";

fn bounds(top: f32, left: f32, bottom: f32, right: f32) -> Bounds {
    Bounds {
        top,
        left,
        bottom,
        right,
    }
}

/// One of each page item, a group, an inline image, a threaded story and a
/// symbol with its instance: small, built in code (so it does not move
/// with an importer), and with at most one entry per map (so its encoding
/// has one order).
fn golden_document() -> Document {
    let mut spread = Spread {
        self_id: Some("u10".into()),
        ..Default::default()
    };
    spread.pages.push(paged_model::Page::new(
        "u11",
        bounds(0.0, 0.0, 792.0, 612.0),
    ));
    let mut head = paged_model::TextFrame::new(
        "u12",
        Some("Story/u1".into()),
        bounds(36.0, 36.0, 200.0, 300.0),
    );
    head.next_text_frame = Some("u13".into());
    let tail = paged_model::TextFrame::new(
        "u13",
        Some("Story/u1".into()),
        bounds(220.0, 36.0, 400.0, 300.0),
    );
    spread.text_frames.extend([head, tail]);
    let mut image = paged_model::Rectangle::new("u14", bounds(36.0, 320.0, 136.0, 420.0));
    image.image_bytes = Some(b"not a real image".to_vec());
    spread.rectangles.push(image);
    spread.ovals.push(paged_model::Oval::new(
        "u15",
        bounds(150.0, 320.0, 250.0, 420.0),
    ));
    spread.graphic_lines.push(paged_model::GraphicLine::new(
        "u16",
        bounds(260.0, 320.0, 260.0, 420.0),
    ));
    spread.polygons.push(paged_model::Polygon::new(
        "u17",
        bounds(270.0, 320.0, 370.0, 420.0),
    ));
    spread.groups.push(Group {
        self_id: Some("u18".into()),
        members: vec![FrameRef::Oval(0), FrameRef::GraphicLine(0)],
        ..Default::default()
    });
    spread.instances.push(paged_model::SymbolInstance {
        self_id: Some("u19".into()),
        symbol: "Symbol/u1".into(),
        item_transform: [1.0, 0.0, 0.0, 1.0, 400.0, 500.0],
        item_layer: None,
        visible: true,
        locked: false,
        overrides: Default::default(),
        nine_slice: None,
        bounds: Bounds::ZERO,
    });
    spread.frames_in_order = vec![
        FrameRef::TextFrame(0),
        FrameRef::TextFrame(1),
        FrameRef::Rectangle(0),
        FrameRef::Group(0),
        FrameRef::Polygon(0),
        FrameRef::Instance(0),
    ];

    let mut items = Spread::default();
    items.rectangles.push(paged_model::Rectangle::new(
        "u1a",
        bounds(-10.0, -10.0, 10.0, 10.0),
    ));
    items.frames_in_order = vec![FrameRef::Rectangle(0)];

    let mut story = Story::default();
    story.paragraphs.push(Paragraph {
        runs: vec![paged_model::CharacterRun {
            text: "A golden paragraph.".into(),
            point_size: Some(12.0),
            ..Default::default()
        }],
        ..Default::default()
    });

    Document {
        spreads: vec![ParsedSpread {
            src: "Spreads/Spread_u10.xml".into(),
            spread,
        }],
        stories: vec![ParsedStory {
            src: "Stories/Story_u1.xml".into(),
            self_id: "Story/u1".into(),
            story,
        }],
        symbols: vec![paged_model::SymbolDefinition {
            id: "Symbol/u1".into(),
            name: "Mark".into(),
            revision: 1,
            items,
            stories: Vec::new(),
            bounds: bounds(-10.0, -10.0, 10.0, 10.0),
            nine_slice: None,
        }],
        ..Default::default()
    }
}

/// The key paths of `value` with the JSON type at each; an array is one
/// `[]` step whatever its length, and values are left out.
fn shape_of(value: &serde_json::Value) -> String {
    fn walk(value: &serde_json::Value, path: &str, out: &mut BTreeMap<String, &'static str>) {
        use serde_json::Value as V;
        let kind = match value {
            V::Null => "null",
            V::Bool(_) => "bool",
            V::Number(_) => "number",
            V::String(_) => "string",
            V::Array(_) => "array",
            V::Object(_) => "object",
        };
        // A path seen as null and as a value is that value, optionally.
        match out.get(path).copied() {
            Some(seen) if seen != "null" => {}
            _ => {
                out.insert(path.to_string(), kind);
            }
        }
        match value {
            V::Array(items) => {
                for item in items {
                    walk(item, &format!("{path}[]"), out);
                }
            }
            V::Object(map) => {
                for (key, item) in map {
                    walk(item, &format!("{path}.{key}"), out);
                }
            }
            _ => {}
        }
    }
    let mut out = BTreeMap::new();
    walk(value, "$", &mut out);
    out.iter()
        .map(|(path, kind)| format!("{path}: {kind}\n"))
        .collect()
}

/// The lines only one side holds, for a failure a reader can act on.
fn shape_diff(committed: &str, fresh: &str) -> String {
    let a: std::collections::BTreeSet<&str> = committed.lines().collect();
    let b: std::collections::BTreeSet<&str> = fresh.lines().collect();
    let mut out = String::new();
    for line in a.difference(&b) {
        out.push_str(&format!("  - {line}\n"));
    }
    for line in b.difference(&a) {
        out.push_str(&format!("  + {line}\n"));
    }
    out
}

/// Write `bytes` to `path` when the mode allows it; whether it was written.
fn write_if_asked(path: &PathBuf, bytes: &[u8]) -> bool {
    let allowed = match mode().as_deref() {
        Some("rewrite") => true,
        Some("write") => !path.exists(),
        _ => false,
    };
    if allowed {
        std::fs::create_dir_all(dir()).expect("golden dir");
        std::fs::write(path, bytes).expect("write golden");
    }
    allowed
}

#[test]
fn the_current_versions_golden_part_decodes_and_re_encodes_identically() {
    let version = paged_store::PGM_FORMAT_VERSION;
    let path = part_path(version);
    let fresh = paged_store::to_bytes(&golden_document()).expect("encode");
    write_if_asked(&path, &fresh);
    let golden = std::fs::read(&path)
        .unwrap_or_else(|e| panic!("no golden part for format version {version} ({e}): {HOW}"));
    let doc = match paged_store::from_bytes(&golden) {
        Ok(doc) => doc,
        Err(e) => panic!("the golden part of version {version} no longer reads ({e}): {HOW}"),
    };
    let again = paged_store::to_bytes(&doc).expect("re-encode");
    assert!(
        again == golden,
        "the golden part of version {version} re-encodes differently:\n{}\n{HOW}",
        shape_diff(
            &shape_of(&serde_json::from_slice(&golden).expect("golden json")),
            &shape_of(&serde_json::from_slice(&again).expect("re-encoded json")),
        )
    );
    // The document the golden was made from is still what the code builds.
    assert!(
        fresh == golden,
        "the golden document encodes differently from its committed part: {HOW}"
    );
}

#[test]
fn the_models_serialised_shape_is_the_current_versions_snapshot() {
    let version = paged_store::PGM_FORMAT_VERSION;
    let path = shape_path(version);
    let bytes = paged_store::to_bytes(&golden_document()).expect("encode");
    let fresh = format!(
        "# paged-store model shape, format version {version}. Generated: see tests/it/golden.rs\n{}",
        shape_of(&serde_json::from_slice(&bytes).expect("json"))
    );
    write_if_asked(&path, fresh.as_bytes());
    let committed = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("no shape snapshot for format version {version} ({e}): {HOW}"));
    assert!(
        committed == fresh,
        "the serialised shape differs from the version {version} snapshot \
         (- snapshot, + now):\n{}\n{HOW}",
        shape_diff(&committed, &fresh)
    );
}

/// Every committed golden part of a version this build still reads does
/// read; one older than that is refused as stale, never mis-read.
#[test]
fn every_committed_golden_part_reads_or_is_refused_by_its_version() {
    // In a write run the tests race; make sure the current part is there.
    write_if_asked(
        &part_path(paged_store::PGM_FORMAT_VERSION),
        &paged_store::to_bytes(&golden_document()).expect("encode"),
    );
    let mut seen = 0;
    for entry in std::fs::read_dir(dir()).expect("golden dir") {
        let path = entry.expect("entry").path();
        let Some(version) = path
            .file_name()
            .and_then(|n| n.to_str())
            .and_then(|n| n.strip_prefix("document.v"))
            .and_then(|n| n.strip_suffix(".pgm"))
            .and_then(|n| n.parse::<u32>().ok())
        else {
            continue;
        };
        seen += 1;
        let read = paged_store::from_bytes(&std::fs::read(&path).expect("read"));
        if version < paged_store::OLDEST_READABLE_PGM {
            assert!(
                matches!(
                    read,
                    Err(paged_store::PgmError::StaleVersion { found, .. }) if found == version
                ),
                "version {version} is older than this build reads and must be refused as stale"
            );
        } else {
            assert!(
                read.is_ok(),
                "the golden part of version {version} must read"
            );
        }
    }
    assert!(seen > 0, "tests/golden holds no model part");
}
