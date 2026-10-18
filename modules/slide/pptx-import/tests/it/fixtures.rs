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

//! The PowerPoint-authored fixtures read into the IR with what PowerPoint
//! wrote (slide-conformance/fixtures; ADR 705). These are licence-clear and
//! committed, so unlike the corpus test nothing here can skip.

use pptx_core::{Autofit, Geometry, Presentation, Shape, Sp};

fn fixture(name: &str) -> Presentation {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../slide-conformance/fixtures")
        .join(format!("{name}.pptx"));
    let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    pptx_import::import_pptx(&bytes).unwrap()
}

fn sps(shapes: &[Shape]) -> Vec<&Sp> {
    shapes
        .iter()
        .filter_map(|s| match s {
            Shape::Sp(sp) => Some(sp),
            _ => None,
        })
        .collect()
}

#[test]
fn geometry_reads_every_preset_powerpoint_offers() {
    let deck = fixture("geometry");
    let mut presets: Vec<String> = deck
        .slides
        .iter()
        .flat_map(|s| sps(&s.shapes))
        .filter(|sp| !sp.nv.name.starts_with("label "))
        .filter_map(|sp| match &sp.props.geometry {
            Some(Geometry::Preset { name, .. }) => Some(name.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(presets.len(), 182);
    presets.sort();
    presets.dedup();
    assert!(presets.len() >= 170, "distinct presets: {}", presets.len());
    for must in [
        "rect",
        "roundRect",
        "ellipse",
        "rightArrow",
        "wedgeRectCallout",
        "star5",
    ] {
        assert!(presets.iter().any(|p| p == must), "missing {must}");
    }
}

#[test]
fn text_reads_levels_notes_spacing_and_autofit() {
    let deck = fixture("text");
    let lists = &deck.slides[0];
    let body = sps(&lists.shapes)[1].text.as_ref().unwrap();
    let levels: Vec<Option<u8>> = body.paragraphs.iter().map(|p| p.props.level).collect();
    assert_eq!(levels, vec![None, Some(1), Some(2), Some(3), Some(4), None]);
    let notes = lists.notes.as_ref().expect("notes");
    assert!(notes.paragraphs.len() >= 2);

    let shrink = sps(&deck.slides[2].shapes)[1].text.as_ref().unwrap();
    assert_eq!(
        shrink.body.autofit,
        Some(Autofit::Normal {
            font_scale: Some(40_000),
            line_spacing_reduction: Some(20_000)
        })
    );

    let boxes = sps(&deck.slides[1].shapes);
    let spacing = boxes.iter().find(|s| s.nv.name == "spacing").unwrap();
    assert_eq!(
        spacing.text.as_ref().unwrap().paragraphs[0]
            .props
            .line_spacing,
        Some(pptx_core::Spacing::Percent(150_000))
    );
}

#[test]
fn placeholders_read_type_and_idx() {
    let deck = fixture("placeholders");
    assert_eq!(deck.slides.len(), 10);
    let first = sps(&deck.slides[0].shapes);
    let kinds: Vec<Option<&str>> = first
        .iter()
        .map(|s| s.nv.placeholder.as_ref().and_then(|p| p.kind.as_deref()))
        .collect();
    assert!(kinds.contains(&Some("ctrTitle")), "{kinds:?}");
    assert!(kinds.contains(&Some("subTitle")), "{kinds:?}");
    // The moved title carries its own transform; the body inherits its layout's.
    let moved = sps(&deck.slides[9].shapes);
    assert!(moved[0].props.xfrm.is_some());
    assert!(moved[1].props.xfrm.is_none());
}

#[test]
fn motion_reads_transitions_and_timing() {
    let deck = fixture("motion");
    let kinds: Vec<Option<&str>> = deck
        .slides
        .iter()
        .map(|s| s.transition.as_ref().and_then(|t| t.kind.as_deref()))
        .collect();
    assert_eq!(
        kinds,
        vec![Some("fade"), Some("push"), Some("wipe"), Some("cut"), None]
    );
    let wipe = deck.slides[2].transition.as_ref().unwrap();
    assert_eq!(wipe.dir.as_deref(), Some("d"));
    // PowerPoint wraps a transition with a p14 duration in
    // mc:AlternateContent; the wrapper is what export writes back.
    assert!(wipe.xml.starts_with("<mc:AlternateContent"), "{}", wipe.xml);
    assert!(wipe.xml.contains("<p:wipe"));
    assert_eq!(wipe.duration_ms, Some(1500));
    let timing = deck.slides[4].timing_xml.as_deref().expect("timing");
    assert!(timing.contains("mainSeq"));
    assert_eq!(timing.matches("presetClass=\"entr\"").count(), 4);
}
