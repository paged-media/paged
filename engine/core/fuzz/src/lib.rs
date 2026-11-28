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

//! The bodies of the engine's fuzz targets, one function each.
//!
//! The property every target holds is the same: a parser handed arbitrary
//! bytes returns (a value or a typed error). It never panics, never hangs
//! and never allocates past what its limits allow; the wasm builds abort on
//! a panic, so a panic here is a crash for a user. libFuzzer watches the
//! other two through `-timeout` and `-rss_limit_mb`
//! (`.github/workflows/engine-fuzz.yml`).
//!
//! The functions live here, not in `fuzz_targets/`, so `tests/smoke.rs` runs
//! the same code over the seeds on the stable toolchain.

use std::collections::HashMap;
use std::io::{Cursor, Read, Write};
use std::sync::OnceLock;

pub mod hostile;

/// A fuzz target: its name (the binary, the `seeds/` directory and the
/// prefix of its files in `regressions/`) and its body.
pub type Target = (&'static str, fn(&[u8]));

/// Every target, in the order of the workflow's matrix.
pub const TARGETS: &[Target] = &[
    ("idml_import", idml_import),
    ("idml_parts", idml_parts),
    ("paged_model", paged_model),
    ("paged_container", paged_container),
    ("psd", psd),
    ("postscript", postscript),
    ("ooxml_opc", ooxml_opc),
    ("ooxml_xml", ooxml_xml),
    ("docx_import", docx_import),
    ("docx_parts", docx_parts),
    ("pptx_import", pptx_import),
    ("pptx_parts", pptx_parts),
    ("data_expr", data_expr),
    ("dxf", dxf),
    ("svg_import", svg_import),
    ("raster", raster),
    ("pdf_import", pdf_import),
];

/// The sound packages the `*_parts` targets rebuild with one part replaced.
pub const IDML_BASE: &[u8] = include_bytes!("../seeds/idml_import/join.idml");
pub const DOCX_BASE: &[u8] = include_bytes!("../seeds/docx_import/two-columns.docx");
pub const PPTX_BASE: &[u8] = include_bytes!("../seeds/pptx_import/effect-stack.pptx");

/// The file entries of a zip, in order.
pub fn entries_of(package: &[u8]) -> Vec<(String, Vec<u8>)> {
    let mut out = Vec::new();
    let Ok(mut archive) = zip::ZipArchive::new(Cursor::new(package)) else {
        return out;
    };
    for i in 0..archive.len() {
        let Ok(mut entry) = archive.by_index(i) else {
            continue;
        };
        if entry.is_dir() {
            continue;
        }
        let Ok(name) = entry.name().map(|n| n.into_owned()) else {
            continue;
        };
        let mut bytes = Vec::new();
        if entry.read_to_end(&mut bytes).is_ok() {
            out.push((name, bytes));
        }
    }
    out
}

/// A zip of `entries`: `mimetype` stored, as OCF asks, the rest deflated.
pub fn zip_of(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut buf = Vec::new();
    {
        let mut zip = zip::ZipWriter::new(Cursor::new(&mut buf));
        for (name, bytes) in entries {
            let method = if *name == "mimetype" {
                zip::CompressionMethod::Stored
            } else {
                zip::CompressionMethod::Deflated
            };
            let options = zip::write::SimpleFileOptions::default().compression_method(method);
            if zip.start_file(*name, options).is_err() || zip.write_all(bytes).is_err() {
                return Vec::new();
            }
        }
        if zip.finish().is_err() {
            return Vec::new();
        }
    }
    buf
}

/// The parts of `base` a `*_parts` input may replace: every entry but
/// `mimetype`, in the package's order.
pub fn replaceable(base: &[(String, Vec<u8>)]) -> Vec<usize> {
    (0..base.len())
        .filter(|&i| base[i].0 != "mimetype")
        .collect()
}

/// `base` with one part replaced: the first byte of `data` picks the part
/// (modulo the replaceable parts), the rest is its new content. So the zip
/// stays sound and the mutation reaches the part readers, which a mutated
/// zip rarely does (its checksums fail first).
fn repack(base: &[(String, Vec<u8>)], data: &[u8]) -> Option<Vec<u8>> {
    let (&pick, body) = data.split_first()?;
    let slots = replaceable(base);
    let target = *slots.get(pick as usize % slots.len().max(1))?;
    let entries: Vec<(&str, &[u8])> = base
        .iter()
        .enumerate()
        .map(|(i, (name, bytes))| (name.as_str(), if i == target { body } else { &bytes[..] }))
        .collect();
    Some(zip_of(&entries))
}

fn base(
    cell: &'static OnceLock<Vec<(String, Vec<u8>)>>,
    bytes: &[u8],
) -> &'static [(String, Vec<u8>)] {
    cell.get_or_init(|| entries_of(bytes))
}

// ---------------------------------------------------------------- IDML

pub fn idml_import(data: &[u8]) {
    let _ = idml_import::import_idml_doc(data);
}

pub fn idml_parts(data: &[u8]) {
    static BASE: OnceLock<Vec<(String, Vec<u8>)>> = OnceLock::new();
    if let Some(package) = repack(base(&BASE, IDML_BASE), data) {
        let _ = idml_import::import_idml_doc(&package);
    }
}

// ------------------------------------------------------------- .paged

pub fn paged_model(data: &[u8]) {
    if let Ok(document) = paged_store::from_bytes(data) {
        // What reads must write: the part a save would store.
        let _ = paged_store::to_bytes(&document);
    }
}

/// The store's own container reader, then the steps of the renderer's
/// `container::open_document` (which this crate does not link: it brings the
/// rasterizers): the archive, the model part with the container's blobs, and
/// the IDML parts when the model part does not reconstruct.
pub fn paged_container(data: &[u8]) {
    let _ = paged_store::package::read_document(data);

    let Ok(archive) = idml_import::open_source_archive(data) else {
        return;
    };
    let model_part = archive.entry(paged_store::DOCUMENT_PGM_PATH).map(|pgm| {
        let blobs: HashMap<String, Vec<u8>> = archive
            .entries
            .iter()
            .filter_map(|(path, bytes)| {
                paged_store::blob_name_of(path).map(|name| (name.to_string(), bytes.to_vec()))
            })
            .collect();
        paged_store::from_parts(&pgm[..], blobs)
    });
    if !matches!(model_part, Some(Ok(_))) {
        let _ = idml_import::import_idml_archive(&archive);
    }
}

// ---------------------------------------------------------------- PSD

pub fn psd(data: &[u8]) {
    let Ok(file) = paged_psd::PsdFile::parse(data) else {
        return;
    };
    let _ = file.composite_rgba8();
    let _ = file.composite_cmyk8();
    let _ = file.composite_samples();
    let _ = file.indexed_palette();
    let _ = file.layer_list();
    let _ = file.layer_plates_rgba8();
    let _ = file.write();
}

// --------------------------------------------------------- PostScript

/// Limits far under the defaults, so a run that reaches one is fast: the
/// fuzzer then finds what gets past a limit, not what a limit allows.
fn ps_limits() -> paged_ps::Limits {
    paged_ps::Limits {
        max_operations: 200_000,
        max_memory: 16 << 20,
        max_time: Some(std::time::Duration::from_secs(5)),
        max_nesting: 48,
        max_stack: 10_000,
        max_exec_stack: 2_000,
        max_elements: 20_000,
    }
}

pub fn postscript(data: &[u8]) {
    let _ = paged_ps::dsc(data);
    let options = paged_ps::Options {
        limits: ps_limits(),
        fonts: None,
    };
    let _ = paged_ps::interpret(data, &options);
}

// -------------------------------------------------------------- OOXML

/// The uncompressed bytes an OOXML target lets one package hold.
const OOXML_BUDGET: u64 = 64 << 20;

pub fn ooxml_opc(data: &[u8]) {
    let _ = paged_ooxml::opc::sniff_legacy(data);
    let _ = paged_ooxml::opc::read_zip(data, OOXML_BUDGET);
    let Ok(package) = paged_ooxml::OpcPackage::read_with_budget(data, OOXML_BUDGET) else {
        return;
    };
    if let Some(part) = package.part(paged_ooxml::CONTENT_TYPES_PART) {
        let _ = paged_ooxml::ContentTypes::parse(part);
    }
    let names: Vec<String> = package.names().map(str::to_string).collect();
    for name in &names {
        if name.ends_with(".rels") {
            if let Some(part) = package.part(name) {
                let _ = paged_ooxml::Relationships::parse(part);
            }
        }
    }
    let _ = package.write();
}

pub fn ooxml_xml(data: &[u8]) {
    if let Ok(root) = paged_ooxml::tree::parse(data) {
        let _ = paged_ooxml::omml::read_all(&root);
    }
    let _ = paged_ooxml::tree::XNode::parse(data);
    let _ = paged_ooxml::ContentTypes::parse(data);
    let _ = paged_ooxml::Relationships::parse(data);
    let _ = paged_ooxml::drawingml::theme::Theme::parse(data);
    let _ = paged_ooxml::docprops::read(Some(data), Some(data));
    if let Ok(text) = std::str::from_utf8(data) {
        let _ = paged_ooxml::omml::parse_all(text);
    }
}

pub fn docx_import(data: &[u8]) {
    let _ = docx_import::import_docx(data);
}

pub fn docx_parts(data: &[u8]) {
    static BASE: OnceLock<Vec<(String, Vec<u8>)>> = OnceLock::new();
    if let Some(package) = repack(base(&BASE, DOCX_BASE), data) {
        let _ = docx_import::import_docx(&package);
    }
}

fn pptx(package: &[u8]) {
    let _ = pptx_import::import_pptx(package);
    let _ = pptx_import::themes_in(package);
    let _ = pptx_import::embedded_faces(package);
}

pub fn pptx_import(data: &[u8]) {
    pptx(data);
}

pub fn pptx_parts(data: &[u8]) {
    static BASE: OnceLock<Vec<(String, Vec<u8>)>> = OnceLock::new();
    if let Some(package) = repack(base(&BASE, PPTX_BASE), data) {
        pptx(&package);
    }
}

// --------------------------------------------------- data expressions

pub fn data_expr(data: &[u8]) {
    use data_core::Value;
    let Ok(source) = std::str::from_utf8(data) else {
        return;
    };
    let record = data_expr::SimpleCtx::new()
        .with_field("name", Value::text("Ada"))
        .with_field("price", Value::Number(12.5))
        .with_field("qty", Value::Number(3.0))
        .with_field("in_stock", Value::Bool(true))
        .with_field("date", Value::Date(20_000))
        .with_field("empty", Value::Null)
        .with_param("rate", Value::Number(0.2));
    let ctx = data_expr::EvalCtx::new(&record, 20_000);
    if let Ok(expr) = data_expr::parse(source) {
        let _ = data_expr::eval(&expr, &ctx);
    }
    let _ = data_expr::eval_str(source, &ctx);
    let _ = data_expr::field_refs(source);
}

// ------------------------------------------------- DXF, SVG, rasters

pub fn dxf(data: &[u8]) {
    let _ = draw_dxf::dxf_to_svg(data);
}

pub fn svg_import(data: &[u8]) {
    let target = paged_svg::ImportTarget {
        page_id: paged_wire::PageId("page".to_string()),
        page_origin: [0.0, 0.0],
        page_size: [612.0, 792.0],
    };
    let options = paged_svg::SvgImportOptions::default();
    let _ = paged_svg::plan_import(data, &target, &options, &[], &());
}

/// The longer edge a decode is asked to stay within.
const RASTER_MAX_DIM: u32 = 64;

pub fn raster(data: &[u8]) {
    let _ = paged_raster::sniff(data);
    let _ = paged_raster::probe(data);
    let _ = paged_raster::probe_page(data, 1);
    let _ = paged_raster::decode_rgba8(data, Some(RASTER_MAX_DIM));
}

// ---------------------------------------------------------------- PDF

pub fn pdf_import(data: &[u8]) {
    let _ = pdf_import::pdf_inspect(data);
    let _ = pdf_import::pdf_comments(data);
    let _ = pdf_import::pdf_place(data, r#"{"page":0,"placement":[1,0,0,1,0,0]}"#);
    let _ = pdf_import::pdf_reconstruct(data, "{}", Vec::new());
}
