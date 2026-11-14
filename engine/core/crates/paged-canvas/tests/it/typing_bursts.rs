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

//! Editor ADR 1232 amendment (UX audit F-56) — a burst of typing is laid
//! out incrementally (ADR 027: the edited story resumes at the edit and
//! stops where its flow rejoins the previous build's; the other stories'
//! emissions are reused; unchanged pages are adopted), and the result is
//! the whole document's composition. Property test: seeded random bursts —
//! folded inserts of one to six characters (the editor's typing coalescer
//! sends what was typed behind an insert in flight as one), paragraph
//! breaks, backspaces and word deletes, at random places in random stories
//! — on several multi-page documents; after every operation the model is
//! compared with a cold build of its scene (`digest_gate_check`: page ids,
//! every page's display-list digest, line geometry and the diagnostics),
//! and every page an operation did not report changed kept its digest.

use paged_canvas::{CanvasModel, CanvasOptions, Mutation};

fn corpus(rel: &str) -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../corpus")
        .join(rel)
}

fn load(bytes: &[u8]) -> CanvasModel {
    let opts = CanvasOptions {
        fonts: vec![std::fs::read(corpus("fonts/Inter.ttf")).expect("read Inter.ttf")],
        ..CanvasOptions::default()
    };
    CanvasModel::load("doc", bytes, opts).expect("load")
}

fn sample(build: fn() -> paged_gen::package::Sample) -> Vec<u8> {
    paged_gen::write_idml(&build()).expect("write_idml")
}

/// A small deterministic generator (xorshift64*), so a failure replays.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n.max(1)
    }
}

/// Byte length of story `id`'s text in `InsertText`'s convention (each
/// paragraph's runs, then one byte for its break).
fn story_len(m: &CanvasModel, id: &str) -> u32 {
    m.scene()
        .stories
        .iter()
        .find(|s| s.self_id == id)
        .map(|s| {
            s.story
                .paragraphs
                .iter()
                .map(|p| p.runs.iter().map(|r| r.text.len() as u32).sum::<u32>() + 1)
                .sum()
        })
        .unwrap_or(0)
}

/// The byte offsets of story `id` that start a character.
fn char_starts(m: &CanvasModel, id: &str) -> Vec<u32> {
    let Some(s) = m.scene().stories.iter().find(|s| s.self_id == id) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut at = 0u32;
    for p in &s.story.paragraphs {
        for r in &p.runs {
            for (i, _) in r.text.char_indices() {
                out.push(at + i as u32);
            }
            at += r.text.len() as u32;
        }
        out.push(at);
        at += 1;
    }
    out
}

/// The stories a reader types into: laid out on a page, with text.
fn typable(m: &CanvasModel) -> Vec<String> {
    let mut ids: Vec<String> = m
        .built()
        .pages
        .iter()
        .flat_map(|p| p.story_layout.iter().map(|l| l.story_id.clone()))
        .filter(|id| !id.is_empty() && story_len(m, id) > 1)
        .collect();
    ids.sort();
    ids.dedup();
    ids
}

fn digests(m: &CanvasModel) -> Vec<(String, u64)> {
    m.built()
        .pages
        .iter()
        .map(|p| (p.id.0.clone(), p.list.digest()))
        .collect()
}

fn burst(name: &str, bytes: &[u8], seed: u64, ops: usize) {
    let mut m = load(bytes);
    let mut rng = Rng(seed);
    let stories = typable(&m);
    assert!(!stories.is_empty(), "{name}: nothing to type into");
    let mut story = stories[0].clone();
    let mut caret: Option<u32> = None;
    for step in 0..ops {
        // Mostly at the advancing caret, now and then somewhere else.
        if caret.is_none() || rng.below(8) == 0 {
            story = stories[rng.below(stories.len() as u64) as usize].clone();
            let starts = char_starts(&m, &story);
            caret = starts.get(rng.below(starts.len() as u64) as usize).copied();
        }
        let at = caret
            .unwrap_or(0)
            .min(story_len(&m, &story).saturating_sub(1));
        let (label, op, moved): (&str, Mutation, i64) = match rng.below(10) {
            0 => (
                "paragraph break",
                Mutation::InsertText {
                    story_id: story.clone(),
                    offset: at,
                    text: "\n".into(),
                    cell: None,
                },
                1,
            ),
            1 | 2 => {
                // Backspace: the character before the caret.
                let starts = char_starts(&m, &story);
                let Some(prev) = starts.iter().rev().find(|&&o| o < at).copied() else {
                    continue;
                };
                (
                    "backspace",
                    Mutation::DeleteRange {
                        story_id: story.clone(),
                        start: prev,
                        end: at,
                        cell: None,
                    },
                    -((at - prev) as i64),
                )
            }
            _ => {
                let n = 1 + rng.below(6) as usize;
                let text: String = "the quick brown fox "
                    .chars()
                    .cycle()
                    .skip(step)
                    .take(n)
                    .collect();
                let len = text.len() as i64;
                (
                    "type",
                    Mutation::InsertText {
                        story_id: story.clone(),
                        offset: at,
                        text,
                        cell: None,
                    },
                    len,
                )
            }
        };
        let before = digests(&m);
        let Ok(outcome) = m.apply_mutation(&op) else {
            caret = None;
            continue;
        };
        caret = Some((at as i64 + moved).max(0) as u32);
        m.digest_gate_check()
            .unwrap_or_else(|e| panic!("{name} seed {seed}: step {step} `{label}`: {e}"));
        let reported: Vec<String> = outcome.page_ids.iter().map(|p| p.0.clone()).collect();
        let after = digests(&m);
        for (id, d) in &after {
            if !reported.contains(id) {
                let was = before.iter().find(|(b, _)| b == id).map(|(_, d)| *d);
                assert_eq!(
                    was,
                    Some(*d),
                    "{name} seed {seed}: step {step} `{label}`: page {id} changed unreported"
                );
            }
        }
    }
}

#[test]
fn typing_bursts_are_laid_out_as_the_whole_document_would_be() {
    use paged_gen::samples as s;
    let docs: Vec<(&str, Vec<u8>)> = vec![
        ("annual-base", sample(s::annual_base::build)),
        ("layout", sample(s::layout::build)),
        ("keeps", sample(s::keeps::build)),
        ("numbering", sample(s::numbering::build)),
        ("footnotes", sample(s::footnotes::build)),
        ("reflow", sample(s::reflow::build)),
    ];
    let ops: usize = std::env::var("PAGED_TYPING_BURST_OPS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(40);
    for (name, bytes) in &docs {
        for seed in [0x9E37_79B9_7F4A_7C15u64, 0xD1B5_4A32_D192_ED03] {
            burst(name, bytes, seed, ops);
        }
    }
}
