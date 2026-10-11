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

//! A written deck read back: the slides the plan named, in its order, with
//! its hidden flags and notes; duplicates are their own parts; an
//! unchanged plan returns the original bytes.

use std::path::PathBuf;

use pptx_export::{export, ExportPlan, SlidePlan};

fn fixture(name: &str) -> Vec<u8> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join(format!("../slide-conformance/fixtures/{name}.pptx"));
    std::fs::read(p).unwrap()
}

fn corpus(pack: &str) -> Option<Vec<u8>> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join(format!("../../../corpus/pptx/packs/{pack}/primary.pptx"));
    std::fs::read(p).ok()
}

fn notes_of(s: &pptx_core::Slide) -> Option<String> {
    s.notes
        .as_ref()
        .map(slide_resolve::text::plain)
        .filter(|n| !n.trim().is_empty())
}

/// The plan that describes the deck as it is.
fn as_is(bytes: &[u8]) -> ExportPlan {
    let ir = pptx_import::import_pptx(bytes).unwrap();
    ExportPlan {
        slides: ir
            .slides
            .iter()
            .map(|s| SlidePlan {
                source_part: s.part.clone(),
                hidden: s.hidden,
                notes: notes_of(s),
                content_edited: false,
            })
            .collect(),
    }
}

#[test]
fn an_unchanged_deck_is_its_original_bytes() {
    for name in ["text", "motion", "placeholders", "tables"] {
        let bytes = fixture(name);
        let out = export(&bytes, &as_is(&bytes)).unwrap();
        assert!(out.bytes == bytes, "{name}: not byte-identical");
        assert!(out.diagnostics.is_empty(), "{name}: {:?}", out.diagnostics);
    }
}

#[test]
fn reorder_duplicate_delete_hide_and_notes_read_back() {
    let bytes = fixture("placeholders");
    let mut plan = as_is(&bytes);
    let n = plan.slides.len();
    assert!(n >= 4, "the fixture has slides to work with");
    let src: Vec<String> = plan.slides.iter().map(|s| s.source_part.clone()).collect();
    // Move the last slide first, drop slide 2, duplicate slide 3, hide it,
    // give the first written slide notes.
    let mut slides = Vec::new();
    slides.push(plan.slides[n - 1].clone());
    slides.push(plan.slides[0].clone());
    slides.push(plan.slides[2].clone());
    let mut copy = plan.slides[2].clone();
    copy.hidden = true;
    slides.push(copy);
    slides.extend(plan.slides[3..n - 1].iter().cloned());
    plan.slides = slides;

    let out = export(&bytes, &plan).unwrap();
    assert!(out.diagnostics.is_empty(), "{:?}", out.diagnostics);
    let back = pptx_import::import_pptx(&out.bytes).unwrap();
    assert_eq!(back.slides.len(), plan.slides.len());

    // Same art per slide as its source (shape names stand in for content).
    let names = |bytes: &[u8], part: &str| -> Vec<String> {
        let ir = pptx_import::import_pptx(bytes).unwrap();
        let s = ir.slides.iter().find(|s| s.part == part).unwrap();
        format!("{:?}", s.shapes.len())
            .lines()
            .map(String::from)
            .collect()
    };
    for (i, (b, p)) in back.slides.iter().zip(&plan.slides).enumerate() {
        assert_eq!(
            format!("{:?}", b.shapes.len()),
            names(&bytes, &p.source_part)[0],
            "slide {}: the content of {}",
            i + 1,
            p.source_part
        );
        assert_eq!(b.hidden, p.hidden, "slide {} hidden", i + 1);
        assert_eq!(notes_of(b), p.notes, "slide {} notes", i + 1);
    }
    // The duplicate is a part of its own.
    let parts: std::collections::BTreeSet<&str> =
        back.slides.iter().map(|s| s.part.as_str()).collect();
    assert_eq!(parts.len(), back.slides.len());
    assert!(
        !back.slides.iter().any(|s| s.part == src[1]),
        "slide 2 is gone"
    );
}

#[test]
fn notes_are_rewritten_where_a_deck_has_them_and_created_where_it_does_not() {
    let Some(bytes) = corpus("creative-agency-profile-powerpoint") else {
        return;
    };
    let mut plan = as_is(&bytes);
    let with = plan.slides.iter().position(|s| s.notes.is_some());
    let without = plan.slides.iter().position(|s| s.notes.is_none()).unwrap();
    if let Some(i) = with {
        plan.slides[i].notes = Some("Rewritten".into());
    }
    plan.slides[without].notes = Some("New notes".into());
    let out = export(&bytes, &plan).unwrap();
    assert!(out.diagnostics.is_empty(), "{:?}", out.diagnostics);
    let back = pptx_import::import_pptx(&out.bytes).unwrap();
    if let Some(i) = with {
        assert_eq!(notes_of(&back.slides[i]).as_deref(), Some("Rewritten"));
    }
    assert_eq!(
        notes_of(&back.slides[without]).as_deref(),
        Some("New notes")
    );
}

#[test]
fn notes_on_a_deck_without_a_notes_master_are_reported_not_lost_silently() {
    let bytes = fixture("placeholders");
    let mut plan = as_is(&bytes);
    plan.slides[0].notes = Some("Opening & <welcome>".into());
    let out = export(&bytes, &plan).unwrap();
    assert_eq!(out.diagnostics.len(), 1, "{:?}", out.diagnostics);
    assert!(out.diagnostics[0].contains("notes master"));
}

#[test]
fn notes_with_markup_characters_and_lines_round_trip() {
    let Some(bytes) = corpus("creative-agency-profile-powerpoint") else {
        return;
    };
    let mut plan = as_is(&bytes);
    plan.slides[0].notes = Some("Opening & <welcome>\n\nthird line".into());
    let out = export(&bytes, &plan).unwrap();
    let back = pptx_import::import_pptx(&out.bytes).unwrap();
    assert_eq!(
        notes_of(&back.slides[0]).as_deref(),
        Some("Opening & <welcome>\n\nthird line")
    );
}

#[test]
fn edited_content_and_foreign_pages_are_reported() {
    let bytes = fixture("text");
    let mut plan = as_is(&bytes);
    plan.slides[0].content_edited = true;
    plan.slides.push(SlidePlan {
        source_part: "ppt/slides/nope.xml".into(),
        hidden: false,
        notes: None,
        content_edited: false,
    });
    let out = export(&bytes, &plan).unwrap();
    assert_eq!(out.diagnostics.len(), 2, "{:?}", out.diagnostics);
}
