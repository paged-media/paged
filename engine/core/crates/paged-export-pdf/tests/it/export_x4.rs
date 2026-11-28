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

//! End-to-end PDF/X-4 conformance + determinism over a corpus
//! fixture, validated by re-parsing the produced bytes with lopdf
//! (the honest, Acrobat-free conformance gate; veraPDF/Acrobat
//! preflight are the manual sign-off lane).
//!
//! The tests over corpus/generated IDMLs (regenerated locally, absent
//! on a fresh checkout) and the one through a licensed CMYK profile
//! report the resource unavailable when it is missing
//! (`paged_test_resources::skip!`, docs/development/testing.md). The
//! PDF/X-4 structure itself is asserted without either, over a sample
//! generated in process and a stand-in output profile.

use paged_export_pdf::{
    export_pdf, ExportInkSettings, ExportInput, ExportOptions, ExportProfiles, PdfStandard,
};
use paged_renderer::pipeline::{self, FontTable, PipelineOptions};
use paged_test_resources::{skip, Resource};

fn fixture_bytes(name: &str) -> Option<Vec<u8>> {
    let manifest = env!("CARGO_MANIFEST_DIR");
    let path = std::path::Path::new(manifest)
        .join("../../corpus/generated")
        .join(name);
    std::fs::read(path).ok()
}

fn fallback_font() -> Option<Vec<u8>> {
    let manifest = env!("CARGO_MANIFEST_DIR");
    let path = std::path::Path::new(manifest).join("../../corpus/fonts/Inter.ttf");
    std::fs::read(path).ok()
}

/// CMYK profile lookup — same chain as paged-color's parity tests.
fn find_cmyk_profile() -> Option<Vec<u8>> {
    if let Ok(p) = std::env::var("PAGED_CMYK_PROFILE") {
        if let Ok(bytes) = std::fs::read(&p) {
            return Some(bytes);
        }
    }
    let manifest = env!("CARGO_MANIFEST_DIR");
    let corpus = std::path::Path::new(manifest).join("../../corpus/profiles");
    if let Ok(entries) = std::fs::read_dir(&corpus) {
        for e in entries.flatten() {
            let path = e.path();
            if path
                .extension()
                .is_some_and(|x| x.eq_ignore_ascii_case("icc"))
            {
                if let Ok(bytes) = std::fs::read(&path) {
                    return Some(bytes);
                }
            }
        }
    }
    let adobe = "/Library/Application Support/Adobe/Color/Profiles/Recommended/CoatedFOGRA39.icc";
    std::fs::read(adobe).ok()
}

struct Built {
    doc: paged_renderer::BuiltDocument,
    fonts: FontTable,
    palette: paged_model::Graphic,
}

fn build_fixture(name: &str, font: &Option<Vec<u8>>) -> Option<Built> {
    let bytes = fixture_bytes(name)?;
    let document = idml_import::import_idml_doc(&bytes)
        .unwrap_or_else(|e| panic!("corpus/generated/{name} does not import: {e:?}"));
    let mut opts = PipelineOptions {
        collect_glyph_runs: true,
        ..Default::default()
    };
    opts.font = font.as_deref();
    let fonts = FontTable::build(&document, &opts);
    let doc = {
        let mut opts2 = PipelineOptions {
            collect_glyph_runs: true,
            ..Default::default()
        };
        opts2.font = font.as_deref();
        opts2.pre_built_font_table = Some(&fonts);
        pipeline::build_document(&document, &opts2).ok()?
    };
    let palette = document.palette.clone();
    Some(Built {
        doc,
        fonts,
        palette,
    })
}

/// Build a `Built` straight from in-memory IDML bytes (so a test can use
/// a `paged-gen` sample without depending on the gitignored
/// corpus/generated fixtures).
fn build_from_bytes(bytes: &[u8], font: &Option<Vec<u8>>) -> Option<Built> {
    let document = idml_import::import_idml_doc(bytes).ok()?;
    let mut opts = PipelineOptions {
        collect_glyph_runs: true,
        ..Default::default()
    };
    opts.font = font.as_deref();
    let fonts = FontTable::build(&document, &opts);
    let doc = {
        let mut opts2 = PipelineOptions {
            collect_glyph_runs: true,
            ..Default::default()
        };
        opts2.font = font.as_deref();
        opts2.pre_built_font_table = Some(&fonts);
        pipeline::build_document(&document, &opts2).ok()?
    };
    let palette = document.palette.clone();
    Some(Built {
        doc,
        fonts,
        palette,
    })
}

fn export(built: &Built, profile: Option<&[u8]>) -> Vec<u8> {
    let cmm = paged_color::IccCmm::new(profile, paged_color::DisplaySetup::default());
    let (standard, condition) = match profile {
        Some(_) => (PdfStandard::PdfX4, Some("Coated FOGRA39".to_string())),
        None => (PdfStandard::Pdf17, None),
    };
    let input = ExportInput {
        doc: &built.doc,
        palette: &built.palette,
        fonts: Some(&built.fonts),
        cmm: &cmm,
        profiles: ExportProfiles {
            cmyk_working: profile,
            output_intent: profile,
            srgb: None,
        },
        inks: ExportInkSettings::default(),
        options: ExportOptions {
            standard,
            output_condition: condition,
            effect_dpi: 150.0,
            ..Default::default()
        },
        doc_bleed: [0.0; 4],
        doc_slug: [0.0; 4],
    };
    let result = export_pdf(input).expect("export");
    assert_eq!(result.pages_exported, built.doc.pages.len());
    result.bytes
}

/// What every export must be, whatever its standard: unencrypted, each
/// page's TrimBox inside its MediaBox, every Type0 font embedded.
fn assert_pdf_shape(bytes: &[u8], doc: &lopdf::Document) {
    assert!(bytes.windows(5).rev().take(64).any(|w| w == b"%%EOF"));
    // No encryption (X-4 forbids it; we never write it).
    assert!(doc.trailer.get(b"Encrypt").is_err(), "unexpected /Encrypt");

    // Every page: TrimBox present and inside MediaBox.
    let pages = doc.get_pages();
    assert!(!pages.is_empty());
    for (_, page_id) in pages {
        let page = doc.get_dictionary(page_id).expect("page dict");
        let trim = page
            .get(b"TrimBox")
            .expect("TrimBox")
            .as_array()
            .expect("arr");
        let media = page
            .get(b"MediaBox")
            .expect("MediaBox")
            .as_array()
            .expect("arr");
        let f = |o: &lopdf::Object| o.as_float().unwrap_or(0.0);
        assert!(f(&trim[0]) >= f(&media[0]) - 1e-3);
        assert!(f(&trim[1]) >= f(&media[1]) - 1e-3);
        assert!(f(&trim[2]) <= f(&media[2]) + 1e-3);
        assert!(f(&trim[3]) <= f(&media[3]) + 1e-3);
    }

    // Embedded fonts: every Type0 font's descendant has a FontFile.
    for obj in doc.objects.values() {
        let Ok(dict) = obj.as_dict() else { continue };
        if dict.get(b"Type").and_then(|t| t.as_name()).ok() != Some(b"Font".as_slice()) {
            continue;
        }
        if dict.get(b"Subtype").and_then(|t| t.as_name()).ok() != Some(b"Type0".as_slice()) {
            continue;
        }
        let desc = dict
            .get(b"DescendantFonts")
            .and_then(|d| d.as_array())
            .expect("DescendantFonts");
        let (_, cid) = doc.dereference(&desc[0]).expect("cid font");
        let cid = cid.as_dict().expect("dict");
        let fd = cid.get(b"FontDescriptor").expect("FontDescriptor");
        let (_, fd) = doc.dereference(fd).expect("deref fd");
        let fd = fd.as_dict().expect("dict");
        assert!(
            fd.get(b"FontFile2").is_ok() || fd.get(b"FontFile3").is_ok(),
            "Type0 font without embedded font file"
        );
    }
}

/// The text of the one XML element `name` of an XMP packet, with the
/// `rdf:Alt` / `rdf:li` wrappers of a language alternative taken off and
/// its character references resolved.
fn xmp_value(xmp: &str, name: &str) -> Option<String> {
    let open = xmp.find(&format!("<{name}"))?;
    let rest = &xmp[open..];
    let body = &rest[rest.find('>')? + 1..rest.find(&format!("</{name}>"))?];
    let text = match body.rfind("</rdf:li>") {
        Some(end) => {
            let inner = &body[..end];
            &inner[inner.rfind('>')? + 1..]
        }
        None => body,
    };
    Some(
        text.trim()
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .replace("&amp;", "&"),
    )
}

/// An Info dictionary text string as text (PDFDocEncoding ASCII or
/// UTF-16BE with a byte-order mark).
fn info_text(info: &lopdf::Dictionary, key: &[u8]) -> Option<String> {
    let bytes = info.get(key).ok()?.as_str().ok()?;
    Some(match bytes.strip_prefix(&[0xFE, 0xFF]) {
        Some(utf16) => String::from_utf16(
            &utf16
                .as_chunks::<2>()
                .0
                .iter()
                .map(|b| u16::from_be_bytes(*b))
                .collect::<Vec<_>>(),
        )
        .expect("UTF-16"),
        None => String::from_utf8_lossy(bytes).into_owned(),
    })
}

/// The two byte strings of the trailer's `/ID`.
fn file_id(doc: &lopdf::Document) -> (Vec<u8>, Vec<u8>) {
    let id = doc
        .trailer
        .get(b"ID")
        .expect("the trailer has an /ID")
        .as_array()
        .expect("an array");
    assert_eq!(id.len(), 2, "/ID holds two strings");
    (
        id[0].as_str().expect("string").to_vec(),
        id[1].as_str().expect("string").to_vec(),
    )
}

/// What ISO 15930-7 asks of a PDF/X-4 file beyond the common shape, read
/// from the written objects. `channels` is the output profile's channel
/// count; `title` what the document is called.
fn assert_x4(bytes: &[u8], doc: &lopdf::Document, channels: i64, title: &str) {
    // Header version (raw bytes — the second header line is the
    // binary-detection comment, not UTF-8).
    assert!(bytes.starts_with(b"%PDF-1.6"), "X-4 must be PDF 1.6");

    // The file identifier: two non-empty strings.
    let (first, second) = file_id(doc);
    assert_eq!(first.len(), 16);
    assert_eq!(first, second, "a file never saved again has equal halves");

    // OutputIntent with GTS_PDFX + DestOutputProfile, whose /N is the
    // profile's own channel count.
    let catalog = doc.catalog().expect("catalog");
    let intents = catalog.get(b"OutputIntents").expect("OutputIntents");
    let arr = intents.as_array().expect("array");
    assert!(!arr.is_empty());
    let oi = doc
        .dereference(&arr[0])
        .expect("deref OutputIntent")
        .1
        .as_dict()
        .expect("dict");
    assert_eq!(
        oi.get(b"S").and_then(|s| s.as_name()).expect("S"),
        b"GTS_PDFX"
    );
    let profile = doc
        .dereference(oi.get(b"DestOutputProfile").expect("DestOutputProfile"))
        .expect("deref profile")
        .1
        .as_stream()
        .expect("stream");
    assert_eq!(
        profile.dict.get(b"N").and_then(|n| n.as_i64()).expect("N"),
        channels,
        "the output profile's /N"
    );

    // DefaultRGB in every page's resources unless the intent is RGB:
    // DeviceRGB content is then defined through an ICCBased space.
    for (_, page_id) in doc.get_pages() {
        let page = doc.get_dictionary(page_id).expect("page dict");
        let resources = doc
            .dereference(page.get(b"Resources").expect("Resources"))
            .expect("deref Resources")
            .1
            .as_dict()
            .expect("dict");
        let spaces = resources
            .get(b"ColorSpace")
            .and_then(|c| doc.dereference(c))
            .ok()
            .and_then(|(_, c)| c.as_dict().ok());
        let default_rgb = spaces.and_then(|c| c.get(b"DefaultRGB").ok());
        if channels == 3 {
            assert!(default_rgb.is_none(), "an RGB intent needs no DefaultRGB");
            continue;
        }
        let space = doc
            .dereference(default_rgb.expect("DefaultRGB under a non-RGB output intent"))
            .expect("deref DefaultRGB")
            .1
            .as_array()
            .expect("[/ICCBased stream]");
        assert_eq!(space[0].as_name().expect("name"), b"ICCBased");
        let icc = doc
            .dereference(&space[1])
            .expect("deref ICC")
            .1
            .as_stream()
            .expect("stream");
        assert_eq!(icc.dict.get(b"N").and_then(|n| n.as_i64()).expect("N"), 3);
        let icc = icc.decompressed_content().unwrap_or(icc.content.clone());
        assert_eq!(icc.get(16..20), Some(b"RGB ".as_slice()), "an RGB profile");
    }

    // XMP metadata stream with the keys X-4 names.
    let meta = catalog.get(b"Metadata").expect("Metadata");
    let (_, meta_obj) = doc.dereference(meta).expect("deref Metadata");
    let stream = meta_obj.as_stream().expect("stream");
    let xmp = String::from_utf8_lossy(&stream.content).into_owned();
    let value =
        |name: &str| xmp_value(&xmp, name).unwrap_or_else(|| panic!("XMP has no {name}:\n{xmp}"));
    assert_eq!(value("pdfxid:GTS_PDFXVersion"), "PDF/X-4");
    assert_eq!(value("pdf:Trapped"), "False");
    assert_eq!(value("dc:title"), title);
    let created = value("xmp:CreateDate");
    assert_eq!(value("xmp:ModifyDate"), created);
    assert_eq!(value("xmp:MetadataDate"), created);
    assert!(value("xmpMM:DocumentID").starts_with("uuid:"));

    // The Info dictionary says the same wherever both speak.
    let info = doc.trailer.get(b"Info").expect("Info");
    let (_, info_obj) = doc.dereference(info).expect("deref Info");
    let info = info_obj.as_dict().expect("dict");
    assert_eq!(
        info.get(b"Trapped")
            .and_then(|t| t.as_name())
            .expect("Trapped"),
        b"False"
    );
    assert_eq!(info_text(info, b"Title").as_deref(), Some(title));
    assert_eq!(info_text(info, b"Creator"), Some(value("xmp:CreatorTool")));
    assert_eq!(info_text(info, b"Producer"), Some(value("pdf:Producer")));
    // `D:YYYYMMDDHHmmSSZ` against `YYYY-MM-DDTHH:mm:SSZ`.
    let digits = |s: &str| -> String { s.chars().filter(char::is_ascii_digit).take(14).collect() };
    for key in [b"CreationDate".as_slice(), b"ModDate"] {
        let date = info_text(info, key).expect("an Info date");
        assert!(date.starts_with("D:"), "{date}");
        assert_eq!(digits(&date), digits(&created), "{date} against {created}");
        assert!(date.ends_with('Z') && created.ends_with('Z'), "both UTC");
    }
}

/// A profile header (no tags) naming `space` as its data colour space:
/// all the exporter reads of an output profile, which it embeds whole.
/// It stands in for the licensed CMYK profile so the PDF/X-4 structure is
/// asserted on every machine; it converts no colour (the CMM here is the
/// profile-less one).
fn stand_in_profile(space: &[u8; 4]) -> Vec<u8> {
    let mut icc = vec![0u8; 128];
    icc[..4].copy_from_slice(&128u32.to_be_bytes());
    icc[12..16].copy_from_slice(b"prtr");
    icc[16..20].copy_from_slice(space);
    icc[20..24].copy_from_slice(b"Lab ");
    icc[36..40].copy_from_slice(b"acsp");
    icc
}

/// The `markers` sample (generated in process) exported as PDF/X-4 with
/// `profile` as its output intent.
fn export_sample_x4(profile: &[u8], title: Option<&str>) -> Vec<u8> {
    let bytes = paged_gen::write_idml(&paged_gen::samples::markers::build()).expect("emit sample");
    let font = fallback_font();
    assert!(font.is_some(), "corpus/fonts/Inter.ttf is committed");
    let built = build_from_bytes(&bytes, &font).expect("the sample imports");
    let cmm = paged_color::IccCmm::new(None, paged_color::DisplaySetup::default());
    export_pdf(ExportInput {
        doc: &built.doc,
        palette: &built.palette,
        fonts: Some(&built.fonts),
        cmm: &cmm,
        profiles: ExportProfiles {
            cmyk_working: None,
            output_intent: Some(profile),
            srgb: None,
        },
        inks: ExportInkSettings::default(),
        options: ExportOptions {
            standard: PdfStandard::PdfX4,
            output_condition: Some("Stand-in".to_string()),
            title: title.map(str::to_string),
            ..Default::default()
        },
        doc_bleed: [0.0; 4],
        doc_slug: [0.0; 4],
    })
    .expect("export")
    .bytes
}

/// The PDF/X-4 structure, on every machine: no licensed profile needed.
#[test]
fn x4_structure_holds_without_a_licensed_profile() {
    let bytes = export_sample_x4(&stand_in_profile(b"CMYK"), Some("Märkte & Marker"));
    let doc = lopdf::Document::load_mem(&bytes).expect("lopdf re-parse");
    assert_pdf_shape(&bytes, &doc);
    assert_x4(&bytes, &doc, 4, "M\u{e4}rkte & Marker");
}

/// An untitled PDF/X-4 still has a title, the same in both places.
#[test]
fn an_untitled_x4_export_is_titled_untitled() {
    let bytes = export_sample_x4(&stand_in_profile(b"CMYK"), None);
    let doc = lopdf::Document::load_mem(&bytes).expect("lopdf re-parse");
    assert_x4(&bytes, &doc, 4, "Untitled");
}

/// The output profile's `/N` is its own channel count, and only an RGB
/// intent goes without DefaultRGB.
#[test]
fn the_output_intent_follows_its_profile() {
    for (space, channels) in [(b"GRAY", 1), (b"RGB ", 3), (b"CMYK", 4)] {
        let bytes = export_sample_x4(&stand_in_profile(space), Some("Intent"));
        let doc = lopdf::Document::load_mem(&bytes).expect("lopdf re-parse");
        assert_x4(&bytes, &doc, channels, "Intent");
    }
}

/// The file identifier is the content's: the same export has the same
/// one, another document another, and a plain PDF 1.7 has one too.
#[test]
fn the_file_id_is_derived_from_the_content() {
    let profile = stand_in_profile(b"CMYK");
    let id = |bytes: &[u8]| file_id(&lopdf::Document::load_mem(bytes).expect("lopdf re-parse"));
    let a = export_sample_x4(&profile, Some("One"));
    let again = export_sample_x4(&profile, Some("One"));
    let other = export_sample_x4(&profile, Some("Two"));
    assert_eq!(a, again, "the same export is the same bytes");
    assert_eq!(id(&a), id(&again));
    assert_ne!(id(&a), id(&other), "another document, another identifier");

    let sample = paged_gen::write_idml(&paged_gen::samples::markers::build()).expect("emit");
    let built = build_from_bytes(&sample, &fallback_font()).expect("the sample imports");
    let plain = export(&built, None);
    assert!(plain.starts_with(b"%PDF-1.7"));
    let (first, second) = id(&plain);
    assert_eq!((first.len(), &first), (16, &second));
}

#[test]
fn x4_export_validates_with_lopdf() {
    let font = fallback_font();
    let Some(built) = build_fixture("geometry.idml", &font) else {
        skip!(
            Resource::Fixtures,
            "corpus/generated/geometry.idml is absent: run scripts/regen-fixtures.sh"
        );
    };
    // The fixture as a plain PDF 1.7: its shape needs no profile.
    let bytes = export(&built, None);
    let doc = lopdf::Document::load_mem(&bytes).expect("lopdf re-parse");
    assert_pdf_shape(&bytes, &doc);

    // As PDF/X-4, through a real CMYK profile. Without one this half is
    // reported unavailable (the structure itself is asserted, with a
    // stand-in profile, by `x4_structure_holds_without_a_licensed_profile`).
    let Some(profile) = find_cmyk_profile() else {
        skip!(
            Resource::Icc,
            "no CMYK profile (set PAGED_CMYK_PROFILE): the fixture's PDF/X-4 export \
             through a real output profile is not checked"
        );
    };
    let bytes = export(&built, Some(&profile));
    let doc = lopdf::Document::load_mem(&bytes).expect("lopdf re-parse");
    assert_pdf_shape(&bytes, &doc);
    assert_x4(&bytes, &doc, 4, "Untitled");
}

#[test]
fn double_export_is_byte_identical() {
    let font = fallback_font();
    let Some(built) = build_fixture("geometry.idml", &font) else {
        skip!(
            Resource::Fixtures,
            "corpus/generated/geometry.idml is absent: run scripts/regen-fixtures.sh"
        );
    };
    let profile = find_cmyk_profile();
    let a = export(&built, profile.as_deref());
    let b = export(&built, profile.as_deref());
    assert_eq!(a, b, "two exports of the same scene must be byte-identical");
}

#[test]
fn effects_fixture_exports_transparency_groups() {
    let font = fallback_font();
    let Some(built) = build_fixture("effects.idml", &font) else {
        skip!(
            Resource::Fixtures,
            "corpus/generated/effects.idml is absent: run scripts/regen-fixtures.sh"
        );
    };
    let bytes = export(&built, None);
    let doc = lopdf::Document::load_mem(&bytes).expect("lopdf re-parse");
    // The effects fixture carries blend modes/opacity — expect at
    // least one transparency-group form XObject in the output.
    let mut groups = 0;
    for obj in doc.objects.values() {
        let Ok(stream) = obj.as_stream() else {
            continue;
        };
        let dict = &stream.dict;
        if dict.get(b"Subtype").and_then(|s| s.as_name()).ok() == Some(b"Form".as_slice())
            && dict.get(b"Group").is_ok()
        {
            groups += 1;
        }
    }
    assert!(
        groups > 0,
        "expected transparency-group forms in effects.idml export"
    );
}

/// Punch-list (AC-PREFLIGHT-2): build-time render diagnostics (overset,
/// missing link / undecodable image) computed at `build_document` are
/// promoted into the export's `PreflightFinding` list. The `preflight`
/// `paged-gen` sample is the "unhealthy publication" — an overset story,
/// a by-design missing font, and an undecodable placed image — so the
/// export must surface >= 2 findings. Self-contained: builds the sample
/// IDML in-memory, no corpus/generated dependency.
#[test]
fn build_diagnostics_promote_to_preflight_findings() {
    let bytes = paged_gen::write_idml(&paged_gen::samples::preflight::build())
        .expect("emit preflight sample IDML");
    let font = fallback_font();
    let built = build_from_bytes(&bytes, &font).expect("the preflight sample imports");

    // Sanity: the build itself collected the document-health diagnostics
    // (the source the exporter now promotes).
    assert!(
        built.doc.diagnostics.len() >= 2,
        "preflight sample should collect >= 2 build diagnostics (overset + \
         broken image); got {:?}",
        built.doc.diagnostics.items,
    );

    let cmm = paged_color::IccCmm::new(None, paged_color::DisplaySetup::default());
    let input = ExportInput {
        doc: &built.doc,
        palette: &built.palette,
        fonts: Some(&built.fonts),
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
    let result = export_pdf(input).expect("export preflight sample");

    // The build diagnostics are promoted into the preflight findings.
    assert!(
        result.findings.len() >= 2,
        "overset + broken image must surface as >= 2 preflight findings \
         through the export path; got {:?}",
        result.findings,
    );
    // The overset finding (a promoted build diagnostic) must be present —
    // the export stage alone would never raise it.
    assert!(
        result
            .findings
            .iter()
            .any(|f| f.code == "overset_text_dropped"),
        "the promoted overset build diagnostic must appear in findings: {:?}",
        result.findings,
    );
}
