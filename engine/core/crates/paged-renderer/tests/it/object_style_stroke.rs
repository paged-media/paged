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

//! An object style's stroke weight reaches the items that apply it (engine
//! ADR 1316). The renderer cascaded a style's fill, tint, stroke colour and
//! corners into an item that leaves them out, but not its stroke weight: a
//! frame of a 3 pt style was stroked at the 1 pt default. Each case is
//! pinned by equivalence, as the corner cases are: the styled item must
//! paint exactly what an item stating that weight itself paints.

use paged_compose::DisplayCommand;
use paged_model::{ObjectStyleCategories, ObjectStyleDef, StyleSheet};

const BOX_PATH: &str = r#"<Properties><PathGeometry><GeometryPathType PathOpen="false"><PathPointArray>
<PathPointType Anchor="50 50" LeftDirection="50 50" RightDirection="50 50"/>
<PathPointType Anchor="50 250" LeftDirection="50 250" RightDirection="50 250"/>
<PathPointType Anchor="250 250" LeftDirection="250 250" RightDirection="250 250"/>
<PathPointType Anchor="250 50" LeftDirection="250 50" RightDirection="250 50"/>
</PathPointArray></GeometryPathType></PathGeometry></Properties>"#;

/// One page holding one `kind` item (`Rectangle` or `TextFrame`) with
/// `attrs`, under `styles`.
fn document(kind: &str, attrs: &str, styles: StyleSheet) -> paged_scene::Document {
    use std::collections::HashMap;
    let xml = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Spread xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="13.1">
<Spread Self="s1" PageCount="1">
<Page Self="p1" Name="1" GeometricBounds="0 0 300 300" ItemTransform="1 0 0 1 0 0"/>
<{kind} Self="i1" GeometricBounds="50 50 250 250" ItemTransform="1 0 0 1 0 0" {attrs}>{BOX_PATH}</{kind}>
</Spread></idPkg:Spread>"#
    );
    let spread = idml_import::parse_spread(xml.as_bytes()).expect("parse spread");
    paged_scene::Document {
        designmap: paged_model::DesignMap::default(),
        palette: idml_import::parse_graphic(
            br#"<idPkg:Graphic xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"><Color Self="Color/Black" Name="Black" Space="CMYK" ColorValue="0 0 0 100"/></idPkg:Graphic>"#,
        )
        .expect("graphic"),
        spreads: vec![paged_scene::ParsedSpread {
            src: "Spreads/syn.xml".to_string(),
            spread,
        }],
        stories: Vec::new(),
        master_spreads: HashMap::new(),
        frame_for_story: HashMap::new(),
        text_frame_index: HashMap::new(),
        styles,
        anchors: Vec::new(),
        symbols: Vec::new(),
        comment_threads: Vec::new(),
        people: Vec::new(),
        theme: None,
    }
}

/// The widths of every stroke the item paints.
fn stroke_widths(kind: &str, attrs: &str, styles: StyleSheet) -> Vec<f32> {
    let options = paged_renderer::pipeline::PipelineOptions::default();
    let built = paged_renderer::pipeline::build_document(&document(kind, attrs, styles), &options)
        .expect("build");
    built.pages[0]
        .list
        .commands
        .iter()
        .filter_map(|cmd| match cmd {
            DisplayCommand::StrokePath { stroke, .. }
            | DisplayCommand::StrokePathOverprint { stroke, .. } => Some(stroke.width),
            _ => None,
        })
        .collect()
}

const APPLIED: &str = r#"AppliedObjectStyle="ObjectStyle/Callout""#;

fn callout(stroke_weight: Option<f32>) -> ObjectStyleDef {
    ObjectStyleDef {
        self_id: "ObjectStyle/Callout".into(),
        name: Some("Callout".into()),
        stroke_color: Some("Color/Black".into()),
        stroke_weight,
        ..Default::default()
    }
}

fn sheet(styles: Vec<ObjectStyleDef>) -> StyleSheet {
    let mut sheet = StyleSheet::default();
    for s in styles {
        sheet.object_styles.insert(s.self_id.clone(), s);
    }
    sheet
}

fn own(kind: &str, weight: &str) -> Vec<f32> {
    stroke_widths(
        kind,
        &format!(r#"StrokeColor="Color/Black" StrokeWeight="{weight}""#),
        StyleSheet::default(),
    )
}

#[test]
fn a_styled_rectangle_strokes_at_its_styles_weight() {
    let drawn = stroke_widths("Rectangle", APPLIED, sheet(vec![callout(Some(3.0))]));
    assert_eq!(drawn, vec![3.0], "the style's 3 pt weight");
    assert_eq!(drawn, own("Rectangle", "3"));
}

/// The scripting lab's case: a text frame, which carries no stroke of its
/// own, takes the style's colour and weight.
#[test]
fn a_styled_text_frame_strokes_at_its_styles_weight() {
    let drawn = stroke_widths(
        "TextFrame",
        &format!(r#"ParentStory="n" {APPLIED}"#),
        sheet(vec![callout(Some(3.0))]),
    );
    assert_eq!(drawn, vec![3.0], "the style's 3 pt weight");
}

#[test]
fn an_items_own_weight_wins_over_its_styles() {
    let drawn = stroke_widths(
        "Rectangle",
        &format!(r#"{APPLIED} StrokeWeight="0.5""#),
        sheet(vec![callout(Some(3.0))]),
    );
    assert_eq!(drawn, own("Rectangle", "0.5"));
}

#[test]
fn the_weight_cascades_through_based_on() {
    let parent = ObjectStyleDef {
        self_id: "ObjectStyle/Parent".into(),
        ..callout(Some(3.0))
    };
    let child = ObjectStyleDef {
        based_on: Some("ObjectStyle/Parent".into()),
        ..callout(None)
    };
    let drawn = stroke_widths("Rectangle", APPLIED, sheet(vec![parent, child]));
    assert_eq!(drawn, own("Rectangle", "3"));
}

/// A style that switches its stroke category off passes neither colour
/// nor weight; one with no weight leaves the 1 pt default.
#[test]
fn no_weight_from_a_style_that_sets_none() {
    let off = ObjectStyleDef {
        enable: ObjectStyleCategories {
            stroke: Some(false),
            ..Default::default()
        },
        ..callout(Some(3.0))
    };
    assert_eq!(
        stroke_widths(
            "Rectangle",
            &format!(r#"{APPLIED} StrokeColor="Color/Black""#),
            sheet(vec![off]),
        ),
        own("Rectangle", "1")
    );
    assert_eq!(
        stroke_widths("Rectangle", APPLIED, sheet(vec![callout(None)])),
        own("Rectangle", "1")
    );
}

/// The raster: the styled rectangle's top edge is as thick as a rectangle
/// stating 3 pt, measured down the middle of the edge at 4 px per pt.
#[test]
fn the_styled_stroke_rasterises_three_points_thick() {
    let thickness = |doc: &paged_scene::Document| -> usize {
        let options = paged_renderer::pipeline::PipelineOptions::default();
        let (_, images) = paged_renderer::pipeline::render_document(
            doc,
            &options,
            288.0,
            paged_compose::Color::WHITE,
        )
        .expect("render");
        let image = &images[0];
        // x = 150 pt, the middle of the top edge (y = 50 pt).
        let x = 150 * 4;
        (40 * 4..60 * 4)
            .filter(|&y| image.get_pixel(x, y).0[0] < 128)
            .count()
    };
    let styled = thickness(&document(
        "Rectangle",
        APPLIED,
        sheet(vec![callout(Some(3.0))]),
    ));
    let stated = thickness(&document(
        "Rectangle",
        r#"StrokeColor="Color/Black" StrokeWeight="3""#,
        StyleSheet::default(),
    ));
    assert_eq!(styled, stated);
    assert!((11..=13).contains(&styled), "3 pt at 4 px/pt: {styled} px");
}
