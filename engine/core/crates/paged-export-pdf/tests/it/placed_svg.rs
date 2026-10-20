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

//! A placed SVG reaches the PDF as vectors (ADR 190, amendment of
//! 2026-10-20): the `svg-vectors` sample's four placements the vectors
//! can follow export their gradients as shadings and embed no image; the
//! stretched one, which keeps the SVG's raster, embeds one.

use paged_export_pdf::{
    export_pdf, ExportInkSettings, ExportInput, ExportOptions, ExportProfiles, PdfStandard,
};
use paged_renderer::pipeline::{self, FontTable, PipelineOptions};

fn exported() -> lopdf::Document {
    let bytes = paged_gen::write_idml(&paged_gen::samples::svg_vectors::build()).unwrap();
    let document = idml_import::import_idml_doc(&bytes).unwrap();
    let opts = PipelineOptions::default();
    let fonts = FontTable::build(&document, &opts);
    let doc = pipeline::build_document(&document, &opts).unwrap();
    let palette = document.palette.clone();
    let cmm = paged_color::IccCmm::new(None, paged_color::DisplaySetup::default());
    let input = ExportInput {
        doc: &doc,
        palette: &palette,
        fonts: Some(&fonts),
        cmm: &cmm,
        profiles: ExportProfiles {
            cmyk_working: None,
            output_intent: None,
            srgb: None,
        },
        inks: ExportInkSettings::default(),
        options: ExportOptions {
            standard: PdfStandard::Pdf17,
            ..Default::default()
        },
        doc_bleed: [0.0; 4],
        doc_slug: [0.0; 4],
    };
    let pdf = export_pdf(input).expect("export").bytes;
    lopdf::Document::load_mem(&pdf).expect("lopdf re-parse")
}

/// The image XObjects (`/Subtype /Image`) that are not another image's
/// soft mask.
fn images(doc: &lopdf::Document) -> usize {
    let dict = |o: &lopdf::Object| match o {
        lopdf::Object::Stream(s) => Some(s.dict.clone()),
        _ => None,
    };
    let masks: Vec<lopdf::ObjectId> = doc
        .objects
        .values()
        .filter_map(dict)
        .filter_map(|d| d.get(b"SMask").ok()?.as_reference().ok())
        .collect();
    doc.objects
        .iter()
        .filter(|(id, o)| {
            !masks.contains(id)
                && dict(o).is_some_and(|d| {
                    d.get(b"Subtype").ok().and_then(|s| s.as_name().ok()) == Some(b"Image")
                })
        })
        .count()
}

/// The shading dictionaries (a `/ShadingType`).
fn shadings(doc: &lopdf::Document) -> usize {
    doc.objects
        .values()
        .filter_map(|o| match o {
            lopdf::Object::Stream(s) => Some(&s.dict),
            lopdf::Object::Dictionary(d) => Some(d),
            _ => None,
        })
        .filter(|d| d.get(b"ShadingType").is_ok())
        .count()
}

#[test]
fn a_placed_svg_exports_as_vectors() {
    let doc = exported();
    // The stretched placement's raster, nothing else.
    assert_eq!(images(&doc), 1);
    // A linear and a radial gradient in each of the four vector placements.
    assert_eq!(shadings(&doc), 8);
}
