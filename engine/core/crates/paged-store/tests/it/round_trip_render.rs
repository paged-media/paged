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

//! N1 proof (Approach A) — the Paged model **self-owns via native bytes, no
//! IDML**. Parse a generated fixture, serialize the model to native `.paged`
//! bytes, reconstruct a fresh `Document` from those bytes with **no
//! `open_source_archive`**, and assert the two render to identical display-list
//! digests.

use paged_renderer::pipeline::{self, PipelineOptions};

#[test]
fn model_round_trips_through_native_bytes_and_renders_identically() {
    // Import a real fixture — the ONLY IDML parse in this test. The
    // reconstruct path below never touches IDML.
    let idml = paged_gen::write_idml(&paged_gen::samples::geometry::build())
        .expect("generate fixture idml");
    let doc = idml_import::import_idml_doc(&idml).expect("import fixture");

    // Native round-trip: model -> bytes -> model (no open_source_archive).
    let bytes = paged_store::to_bytes(&doc).expect("serialize to .pgm");
    let doc2 = paged_store::from_bytes(&bytes).expect("reconstruct from .pgm");

    // The reconstructed model carries NO raw IDML source archive by construction
    // — the scene `Document` has no archive field at all (N9) — yet is fully
    // usable.
    assert_eq!(
        doc.spreads.len(),
        doc2.spreads.len(),
        "spread count diverged"
    );
    assert_eq!(
        doc.stories.len(),
        doc2.stories.len(),
        "story count diverged"
    );

    // Both render to identical display-list digests, per page — the proof that
    // the native reconstruction is render-equivalent to the IDML-parsed model.
    let a = pipeline::build_document(&doc, &PipelineOptions::default()).expect("build original");
    let b =
        pipeline::build_document(&doc2, &PipelineOptions::default()).expect("build reconstructed");
    assert_eq!(a.pages.len(), b.pages.len(), "page count diverged");
    assert!(!a.pages.is_empty(), "fixture must render at least one page");
    for (i, (pa, pb)) in a.pages.iter().zip(b.pages.iter()).enumerate() {
        assert_eq!(
            pa.list.digest(),
            pb.list.digest(),
            "page {i}: native round-trip diverges from the IDML-parsed render"
        );
    }
}

fn fixture_pgm() -> Vec<u8> {
    let idml = paged_gen::write_idml(&paged_gen::samples::geometry::build())
        .expect("generate fixture idml");
    let doc = idml_import::import_idml_doc(&idml).expect("import fixture");
    paged_store::to_bytes(&doc).expect("serialize to .pgm")
}

fn with_version(pgm: &[u8], version: u32) -> serde_json::Value {
    let mut v: serde_json::Value = serde_json::from_slice(pgm).expect("parse envelope");
    v["format_version"] = serde_json::json!(version);
    v
}

fn err_of(bytes: &[u8]) -> paged_store::PgmError {
    match paged_store::from_bytes(bytes) {
        Ok(_) => panic!("the part must not read"),
        Err(e) => e,
    }
}

/// A part stamped with a version this build does not read is rejected, never
/// mis-deserialized (ADR-022 Q2), and the error says which way it is off: a
/// loader refuses a newer part and may replace only an older one.
#[test]
fn incompatible_format_version_is_rejected() {
    let bytes = fixture_pgm();
    assert!(
        paged_store::from_bytes(&bytes).is_ok(),
        "current PGM_FORMAT_VERSION must load"
    );

    let newer = paged_store::PGM_FORMAT_VERSION + 1;
    let future = serde_json::to_vec(&with_version(&bytes, newer)).expect("reserialize");
    let e = err_of(&future);
    assert_eq!(
        e,
        paged_store::PgmError::NewerVersion {
            found: newer,
            supported: paged_store::PGM_FORMAT_VERSION,
        }
    );
    assert!(e.is_newer_version());
    assert!(e.to_string().contains("newer"), "{e}");

    let stale = serde_json::to_vec(&with_version(&bytes, 1)).expect("reserialize");
    let e = err_of(&stale);
    assert!(
        matches!(e, paged_store::PgmError::StaleVersion { found: 1, .. }),
        "{e:?}"
    );
    assert!(!e.is_newer_version());
}

/// A newer part need not have this build's model shape. The version is still
/// the reason reported, not the shape error it causes.
#[test]
fn a_newer_part_of_another_shape_is_still_a_newer_part() {
    let newer = paged_store::PGM_FORMAT_VERSION + 7;
    let future = serde_json::to_vec(&serde_json::json!({
        "format_version": newer,
        "model": { "spreads": "not what this build calls spreads" },
    }))
    .expect("serialize");
    assert_eq!(
        err_of(&future),
        paged_store::PgmError::NewerVersion {
            found: newer,
            supported: paged_store::PGM_FORMAT_VERSION,
        }
    );
}

/// Bytes that are not a model part are corrupt, not a panic and not a
/// version problem.
#[test]
fn a_part_that_is_not_a_model_is_corrupt() {
    for bytes in [
        &b"not json"[..],
        b"{\"not\":\"a model\"}",
        b"{\"format_version\":4,\"model\":7}",
    ] {
        let e = err_of(bytes);
        assert!(matches!(e, paged_store::PgmError::Corrupt(_)), "{e:?}");
    }
    // Truncated mid-way: what an interrupted write leaves.
    let bytes = fixture_pgm();
    let e = err_of(&bytes[..bytes.len() / 2]);
    assert!(matches!(e, paged_store::PgmError::Corrupt(_)), "{e:?}");
}

/// A part that names an image blob the container does not hold says which.
#[test]
fn a_part_whose_image_blob_is_gone_names_the_blob() {
    let mut doc = paged_scene::Document::default();
    let mut spread = paged_model::Spread::default();
    let mut rect = paged_model::Rectangle::new("r1", paged_model::Bounds::ZERO);
    rect.image_bytes = Some(vec![1, 2, 3, 4]);
    spread.rectangles.push(rect);
    doc.spreads.push(paged_scene::ParsedSpread {
        src: "Spreads/Spread_s1.xml".into(),
        spread,
    });
    let (pgm, blobs) = paged_store::to_parts(&doc).expect("parts");
    assert_eq!(blobs.len(), 1, "the image is one blob part");
    let by_name: std::collections::HashMap<String, Vec<u8>> = blobs
        .iter()
        .map(|(path, bytes)| {
            (
                paged_store::blob_name_of(path).expect("blob path").into(),
                bytes.clone(),
            )
        })
        .collect();
    let name = by_name.keys().next().expect("one blob").clone();
    assert!(paged_store::from_parts(&pgm, by_name).is_ok());
    assert_eq!(err_of(&pgm), paged_store::PgmError::MissingBlob { name });
}
