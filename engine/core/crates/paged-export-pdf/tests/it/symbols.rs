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

//! Engine ADR 1039 — a symbol definition is written ONCE, as a form
//! XObject with resources of its own, and every instance on every page is
//! a reference to it under the instance's matrix.

use paged_export_pdf::{export_pdf, ExportInkSettings, ExportInput, ExportOptions, ExportProfiles};
use paged_model::{FrameRef, Spread, SymbolDefinition, SymbolInstance, SymbolStory};
use paged_renderer::pipeline::{self, FontTable, PipelineOptions};

fn instance(id: &str, m: [f32; 6]) -> SymbolInstance {
    SymbolInstance {
        self_id: Some(id.into()),
        symbol: "Symbol/u1".into(),
        item_transform: m,
        item_layer: None,
        visible: true,
        locked: false,
        overrides: Default::default(),
        nine_slice: None,
        bounds: paged_model::Bounds::ZERO,
    }
}

/// The sample's first spread made into a symbol; its page carries two
/// instances, every other spread one.
fn document(sample: &str) -> paged_scene::Document {
    let bytes = paged_gen::write_idml(&paged_gen::samples::build(sample).expect("sample"))
        .expect("emit sample");
    let mut doc = idml_import::import_idml_doc(&bytes).expect("import sample");
    let first = &doc.spreads[0].spread;
    let page = first.pages[0].bounds;
    let mut items = first.clone();
    items.pages.clear();
    let story_ids: Vec<String> = items
        .text_frames
        .iter()
        .filter_map(|f| f.parent_story.clone())
        .collect();
    let stories = doc
        .stories
        .iter()
        .filter(|s| story_ids.contains(&s.self_id))
        .map(|s| SymbolStory {
            self_id: s.self_id.clone(),
            story: s.story.clone(),
        })
        .collect();
    doc.stories.retain(|s| !story_ids.contains(&s.self_id));
    doc.symbols.push(SymbolDefinition {
        id: "Symbol/u1".into(),
        name: "Page art".into(),
        revision: 0,
        items,
        stories,
        bounds: page,
        nine_slice: None,
    });
    for (si, parsed) in doc.spreads.iter_mut().enumerate() {
        let pages = std::mem::take(&mut parsed.spread.pages);
        let self_id = parsed.spread.self_id.clone();
        parsed.spread = Spread {
            self_id,
            pages,
            ..Spread::default()
        };
        parsed.spread.instances.push(instance(
            &format!("ui{si}a"),
            [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
        ));
        parsed.spread.frames_in_order.push(FrameRef::Instance(0));
        if si == 0 {
            parsed
                .spread
                .instances
                .push(instance("ui0b", [0.5, 0.0, 0.0, 0.5, 20.0, 20.0]));
            parsed.spread.frames_in_order.push(FrameRef::Instance(1));
        }
    }
    doc.rebuild_indexes();
    doc
}

fn export(doc: &paged_scene::Document) -> Vec<u8> {
    let opts = PipelineOptions::default();
    let fonts = FontTable::build(doc, &opts);
    let built = {
        let o = PipelineOptions {
            pre_built_font_table: Some(&fonts),
            collect_glyph_runs: true,
            ..PipelineOptions::default()
        };
        pipeline::build_document(doc, &o).expect("build document")
    };
    let cmm = paged_color::IccCmm::new(None, paged_color::DisplaySetup::default());
    export_pdf(ExportInput {
        doc: &built,
        palette: &doc.palette,
        fonts: Some(&fonts),
        cmm: &cmm,
        profiles: ExportProfiles::default(),
        inks: ExportInkSettings::default(),
        options: ExportOptions::default(),
        doc_bleed: [0.0; 4],
        doc_slug: [0.0; 4],
    })
    .expect("export")
    .bytes
}

/// Every `/Sy…` form reference of every page: (page, ref).
fn symbol_refs(pdf: &lopdf::Document) -> Vec<(u32, lopdf::ObjectId)> {
    let mut out = Vec::new();
    for (n, page_id) in pdf.get_pages() {
        let page = pdf.get_dictionary(page_id).expect("page");
        let res = match page.get(b"Resources").expect("resources") {
            lopdf::Object::Reference(r) => pdf.get_dictionary(*r).expect("resources dict"),
            lopdf::Object::Dictionary(d) => d,
            _ => panic!("resources"),
        };
        let Ok(xo) = res.get(b"XObject") else {
            continue;
        };
        let xo = match xo {
            lopdf::Object::Reference(r) => pdf.get_dictionary(*r).expect("xobjects"),
            lopdf::Object::Dictionary(d) => d,
            _ => continue,
        };
        for (name, v) in xo.iter() {
            if name.starts_with(b"Sy") {
                if let lopdf::Object::Reference(r) = v {
                    out.push((n, *r));
                }
            }
        }
    }
    out
}

#[test]
#[allow(non_snake_case)]
fn a_symbol_is_one_form_xobject_however_many_instances_draw_it__feat__frames_paths_symbol_instance()
{
    for sample in ["gradients", "text"] {
        let doc = document(sample);
        let bytes = export(&doc);
        let pdf = lopdf::Document::load_mem(&bytes).expect("re-parse");
        let refs = symbol_refs(&pdf);
        assert!(
            !refs.is_empty(),
            "{sample}: the pages reference the symbol form"
        );
        let distinct: std::collections::BTreeSet<lopdf::ObjectId> =
            refs.iter().map(|(_, r)| *r).collect();
        assert_eq!(
            distinct.len(),
            1,
            "{sample}: one form for every instance: {refs:?}"
        );
        let form_id = *distinct.iter().next().expect("one");
        let form = pdf
            .get_object(form_id)
            .expect("form")
            .as_stream()
            .expect("a stream");
        assert_eq!(
            form.dict.get(b"Subtype").and_then(|s| s.as_name()).ok(),
            Some(&b"Form"[..]),
            "{sample}: a form XObject"
        );
        assert!(
            form.dict.get(b"Resources").is_ok(),
            "{sample}: its own resources"
        );
        // The first page draws it twice (two `Do`s of one name), each in a
        // q … cm … Do … Q of its own.
        let (_, first_page) = pdf.get_pages().into_iter().next().expect("a page");
        let content = String::from_utf8_lossy(&pdf.get_page_content(first_page)).into_owned();
        let dos = content.matches(" Do").count();
        assert!(
            content.matches("/Sy").count() >= 2 && dos >= 2,
            "{sample}: two references on the first page: {content}"
        );
    }
}
