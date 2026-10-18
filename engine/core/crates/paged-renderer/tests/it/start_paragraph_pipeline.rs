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

//! ADR 028 — the break-before rule (`StartParagraph`) over the
//! generated `start-paragraph.idml`, against where InDesign 2025 put each
//! paragraph in its PDF export of the same file (2026-10-01; the fixture
//! is also in the fidelity gate with that PDF as reference).

use paged_gen::ids::self_id;
use paged_gen::samples::start_paragraph::{body_story_id, cases};
use paged_renderer::{pipeline, PipelineOptions};

/// Where InDesign put the paragraph carrying the rule, per case: A1 / A2
/// are frame A's columns (page 1), B is page 1's second frame, C / D are
/// the frames on the case's pages 2 / 3.
const INDESIGN: [&str; 10] = ["A1", "A2", "B", "C", "D", "C", "A1", "C", "B", "A2"];

fn inter_font() -> Vec<u8> {
    let p =
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../corpus/fonts/Inter.ttf");
    std::fs::read(&p).unwrap_or_else(|e| panic!("read Inter.ttf: {e}"))
}

#[test]
fn start_paragraph_lands_where_indesign_puts_it() {
    let bytes = paged_gen::write_idml(&paged_gen::samples::start_paragraph::build()).expect("idml");
    let doc = idml_import::import_idml_doc(&bytes).expect("import");
    let font = inter_font();
    let opts = PipelineOptions {
        font: Some(&font),
        ..PipelineOptions::default()
    };
    let built = pipeline::build_document(&doc, &opts).expect("build");

    let mut engine = Vec::new();
    for (i, case) in cases().iter().enumerate() {
        let seq = i as u32;
        let frame = |f: &str| self_id("start-paragraph", &format!("Frame{f}"), seq);
        let lines = built.story_layout(&body_story_id(seq));
        let line = lines
            .iter()
            .find(|l| l.paragraph_idx + 1 == case.rule_on)
            .unwrap_or_else(|| panic!("{}: the rule's paragraph was not laid out", case.name));
        let id = line.frame_id.clone().unwrap_or_default();
        let x = line
            .clusters
            .iter()
            .map(|c| c.x_pt)
            .fold(f32::INFINITY, f32::min);
        let at = if id == frame("A") {
            if x < 180.0 {
                "A1"
            } else {
                "A2"
            }
        } else {
            ["B", "C", "D", "E"]
                .into_iter()
                .find(|f| id == frame(f))
                .unwrap_or("?")
        };
        engine.push(at);
    }
    let report: Vec<String> = cases()
        .iter()
        .zip(engine.iter().zip(INDESIGN.iter()))
        .map(|(c, (e, w))| format!("{:45} engine {e:3} indesign {w}", c.name))
        .collect();
    assert_eq!(engine, INDESIGN, "\n{}", report.join("\n"));
}
