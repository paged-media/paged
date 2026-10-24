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

//! Engine ADR 1010 — a clip group exports as a PDF clip (`W n`) around
//! its members, and its clipping path is not painted.

use paged_export_pdf::{export_pdf, ExportInkSettings, ExportInput, ExportOptions, ExportProfiles};
use paged_model::{FrameRef, Group};
use paged_renderer::pipeline::{self, FontTable, PipelineOptions};

/// The paste-into sample, its three children taken out of the container
/// and grouped with it on top; `clip` sets the group's flag.
fn export(clip: bool) -> String {
    let bytes =
        paged_gen::write_idml(&paged_gen::samples::paste_into::build()).expect("emit sample");
    let mut document = idml_import::import_idml_doc(&bytes).expect("import sample");
    let spread = &mut document.spreads[0].spread;
    let (host, mut members) = spread.nested_children.drain().next().expect("one host");
    let hi = spread
        .rectangles
        .iter()
        .position(|r| r.self_id.as_deref() == Some(host.as_str()))
        .expect("host");
    members.push(FrameRef::Rectangle(hi));
    spread.groups.push(Group {
        self_id: Some("clipG".into()),
        members,
        clip,
        ..Group::default()
    });
    let gi = spread.groups.len() - 1;
    let slot = spread
        .frames_in_order
        .iter()
        .position(|r| *r == FrameRef::Rectangle(hi))
        .expect("host top-level");
    spread.frames_in_order[slot] = FrameRef::Group(gi);

    let opts = PipelineOptions::default();
    let fonts = FontTable::build(&document, &opts);
    let doc = {
        let o = PipelineOptions {
            pre_built_font_table: Some(&fonts),
            ..PipelineOptions::default()
        };
        pipeline::build_document(&document, &o).expect("build document")
    };
    let cmm = paged_color::IccCmm::new(None, paged_color::DisplaySetup::default());
    let pdf = export_pdf(ExportInput {
        doc: &doc,
        palette: &document.palette,
        fonts: Some(&fonts),
        cmm: &cmm,
        profiles: ExportProfiles::default(),
        inks: ExportInkSettings::default(),
        options: ExportOptions::default(),
        doc_bleed: [0.0; 4],
        doc_slug: [0.0; 4],
    })
    .expect("export")
    .bytes;
    let parsed = lopdf::Document::load_mem(&pdf).expect("re-parse");
    let mut out = Vec::new();
    for (_, page_id) in parsed.get_pages() {
        out.extend(parsed.get_page_content(page_id));
        out.push(b'\n');
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn count(content: &str, ops: &[&str]) -> usize {
    let tokens: Vec<&str> = content.split_whitespace().collect();
    tokens.windows(ops.len()).filter(|w| *w == ops).count()
}

fn paints(content: &str) -> usize {
    content
        .split_whitespace()
        .filter(|t| matches!(*t, "f" | "f*" | "S" | "B" | "B*"))
        .count()
}

#[test]
#[allow(non_snake_case)]
fn a_clip_group_exports_as_a_clip_and_leaves_its_path_unpainted__feat__frames_paths_clip_groups() {
    let clipped = export(true);
    let plain = export(false);
    assert!(
        count(&clipped, &["W", "n"]) > count(&plain, &["W", "n"]),
        "the members are clipped by the path: {} vs {}",
        count(&clipped, &["W", "n"]),
        count(&plain, &["W", "n"])
    );
    assert!(
        paints(&clipped) < paints(&plain),
        "the clipping path's fill and stroke are not drawn: {} vs {}",
        paints(&clipped),
        paints(&plain)
    );
}
