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

//! Engine ADR 1041 — pattern swatches through the mutation layer:
//! `createSwatch` with a `pattern`, edit and delete with exact inverses,
//! the refusals, the spec's round trip through the model, and
//! `FramePatternTransform` on every painted kind.
#![allow(non_snake_case)]

use std::path::PathBuf;

use paged_mutate::operation::PathAnchorSpec;
use paged_mutate::{
    apply, NodeId, Operation, OperationError, PatternColorSpec, PatternItemSpec, PatternSpec,
    PropertyPath, SwatchSpec, Value,
};

fn doc() -> paged_scene::Document {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("corpus")
        .join("generated")
        .join("geometry.idml");
    idml_import::import_idml_doc(&std::fs::read(path).expect("read geometry fixture"))
        .expect("open document")
}

fn pattern(width: f32) -> PatternSpec {
    let a = |x: f32, y: f32| PathAnchorSpec {
        anchor: [x, y],
        left: [x, y],
        right: [x, y],
    };
    PatternSpec {
        width,
        height: 10.0,
        items: vec![PatternItemSpec {
            anchors: vec![a(0.0, 0.0), a(5.0, 0.0), a(5.0, 5.0), a(0.0, 5.0)],
            subpath_starts: vec![],
            subpath_open: vec![],
            fill_rule: None,
            fill: Some(PatternColorSpec {
                swatch: None,
                space: Some("CMYK".into()),
                value: vec![0.0, 100.0, 0.0, 0.0],
            }),
            stroke: Some(PatternColorSpec {
                swatch: Some("Color/Black".into()),
                space: None,
                value: vec![],
            }),
            stroke_weight: Some(0.5),
        }],
        tile_type: Some("BrickByRow".into()),
        brick_offset: Some(1.0 / 3.0),
        h_spacing: Some(2.0),
        v_spacing: Some(-1.0),
        h_overlap: Some("RightInFront".into()),
        v_overlap: None,
        offset: Some([1.0, 2.0]),
        scale: Some([2.0, 2.0]),
        rotation_deg: Some(15.0),
    }
}

fn swatch(id: Option<&str>, p: PatternSpec) -> SwatchSpec {
    SwatchSpec {
        self_id: id.map(str::to_string),
        name: Some("Dots".into()),
        space: String::new(),
        value: vec![],
        model: None,
        alternate_space: None,
        alternate_value: vec![],
        tint: None,
        alpha: None,
        pattern: Some(p),
        theme_ref: None,
    }
}

#[test]
fn create_edit_delete_a_pattern_swatch_with_exact_inverses__feat__color_swatches_pattern_paint() {
    let mut d = doc();
    let colours = d.palette.colors.len();
    let created = apply(
        &mut d,
        &Operation::CreateSwatch {
            spec: swatch(None, pattern(10.0)),
        },
    )
    .expect("create");
    let Operation::CreateSwatch { spec } = &created.op else {
        panic!("echoed create")
    };
    let id = spec.self_id.clone().expect("id assigned");
    assert!(id.starts_with("Pattern/"), "{id}");
    assert_eq!(d.palette.colors.len(), colours, "no colour minted");
    let entry = d.palette.patterns.get(&id).expect("in the pattern pool");
    assert_eq!(entry.name.as_deref(), Some("Dots"));
    assert_eq!(entry.layout.kind, paged_model::PatternTileKind::BrickByRow);
    // The spec round-trips through the model.
    let back = PatternSpec::from_model(entry);
    assert_eq!(
        back.to_model(id.clone(), Some("Dots".into())).unwrap(),
        *entry
    );

    // Edit: the inverse restores the prior pattern exactly.
    let before = entry.clone();
    let edited = apply(
        &mut d,
        &Operation::EditSwatch {
            swatch_id: id.clone(),
            spec: swatch(None, pattern(20.0)),
        },
    )
    .expect("edit");
    assert_eq!(d.palette.patterns[&id].width, 20.0);
    apply(&mut d, &edited.inverse).expect("undo edit");
    assert_eq!(d.palette.patterns[&id], before);

    // Delete: the inverse recreates it at its id.
    let deleted = apply(
        &mut d,
        &Operation::DeleteSwatch {
            swatch_id: id.clone(),
        },
    )
    .expect("delete");
    assert!(!d.palette.patterns.contains_key(&id));
    apply(&mut d, &deleted.inverse).expect("undo delete");
    assert_eq!(d.palette.patterns[&id], before);

    // Undo the create.
    apply(&mut d, &created.inverse).expect("undo create");
    assert!(d.palette.patterns.is_empty());
}

#[test]
fn a_malformed_pattern_is_refused__feat__color_swatches_pattern_paint() {
    let mut d = doc();
    let bad = |p: PatternSpec| Operation::CreateSwatch {
        spec: swatch(None, p),
    };
    let mut zero = pattern(10.0);
    zero.width = 0.0;
    let mut kind = pattern(10.0);
    kind.tile_type = Some("Spiral".into());
    let mut colour = pattern(10.0);
    colour.items[0].fill = Some(PatternColorSpec {
        swatch: None,
        space: Some("RGB".into()),
        value: vec![1.0],
    });
    let mut nested = pattern(10.0);
    nested.items[0].fill = Some(PatternColorSpec {
        swatch: Some("Pattern/other".into()),
        space: None,
        value: vec![],
    });
    let mut pitch = pattern(10.0);
    pitch.h_spacing = Some(-10.0);
    for (what, op) in [
        ("zero tile", bad(zero)),
        ("tile type", bad(kind)),
        ("colour", bad(colour)),
        ("pattern in a pattern", bad(nested)),
        ("no pitch", bad(pitch)),
    ] {
        let err = apply(&mut d, &op).expect_err(what);
        assert!(
            matches!(err, OperationError::InvalidSwatch { .. }),
            "{what}: {err:?}"
        );
    }
    // A pattern under a colour id is refused; nothing was created.
    let err = apply(
        &mut d,
        &Operation::CreateSwatch {
            spec: swatch(Some("Color/x"), pattern(10.0)),
        },
    )
    .expect_err("colour id");
    assert!(matches!(err, OperationError::InvalidSwatch { .. }));
    assert!(d.palette.patterns.is_empty());
    // An edit of a pattern swatch without a pattern is refused.
    apply(
        &mut d,
        &Operation::CreateSwatch {
            spec: swatch(Some("Pattern/p"), pattern(10.0)),
        },
    )
    .unwrap();
    let mut plain = swatch(None, pattern(10.0));
    plain.pattern = None;
    let err = apply(
        &mut d,
        &Operation::EditSwatch {
            swatch_id: "Pattern/p".into(),
            spec: plain,
        },
    )
    .expect_err("edit without a pattern");
    assert!(matches!(err, OperationError::InvalidSwatch { .. }));
}

#[test]
fn a_frame_takes_a_pattern_as_its_fill_and_its_own_transform__feat__color_swatches_pattern_paint() {
    let mut d = doc();
    apply(
        &mut d,
        &Operation::CreateSwatch {
            spec: swatch(Some("Pattern/p"), pattern(10.0)),
        },
    )
    .unwrap();
    let sp = &d.spreads[0].spread;
    let mut nodes = Vec::new();
    if let Some(id) = sp.rectangles.iter().find_map(|r| r.self_id.clone()) {
        nodes.push(NodeId::Rectangle(id));
    }
    if let Some(id) = sp.ovals.iter().find_map(|r| r.self_id.clone()) {
        nodes.push(NodeId::Oval(id));
    }
    if let Some(id) = sp.polygons.iter().find_map(|r| r.self_id.clone()) {
        nodes.push(NodeId::Polygon(id));
    }
    if let Some(id) = sp.graphic_lines.iter().find_map(|r| r.self_id.clone()) {
        nodes.push(NodeId::GraphicLine(id));
    }
    if let Some(id) = sp.text_frames.iter().find_map(|r| r.self_id.clone()) {
        nodes.push(NodeId::TextFrame(id));
    }
    assert!(
        nodes.len() >= 2,
        "the fixture has painted frames: {nodes:?}"
    );
    let m = [0.5, 0.0, 0.0, 0.5, 3.0, 4.0];
    for node in nodes {
        if !matches!(node, NodeId::GraphicLine(_)) {
            apply(
                &mut d,
                &Operation::SetProperty {
                    node: node.clone(),
                    path: PropertyPath::FrameFillColor,
                    value: Value::ColorRef(Some("Pattern/p".into())),
                },
            )
            .unwrap_or_else(|e| panic!("{node:?}: {e:?}"));
        }
        let set = apply(
            &mut d,
            &Operation::SetProperty {
                node: node.clone(),
                path: PropertyPath::FramePatternTransform,
                value: Value::Transform(Some(m)),
            },
        )
        .unwrap_or_else(|e| panic!("{node:?}: {e:?}"));
        assert!(!set.invalidation.frame_style.is_empty());
        let Operation::SetProperty { value, .. } = &set.inverse else {
            panic!("a set inverts to a set")
        };
        assert_eq!(value, &Value::Transform(None), "{node:?}");
        // A singular or non-finite transform is refused.
        for bad in [
            [0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
            [f32::NAN, 0.0, 0.0, 1.0, 0.0, 0.0],
        ] {
            let err = apply(
                &mut d,
                &Operation::SetProperty {
                    node: node.clone(),
                    path: PropertyPath::FramePatternTransform,
                    value: Value::Transform(Some(bad)),
                },
            )
            .expect_err("singular");
            assert!(
                matches!(err, OperationError::InvalidValue { .. }),
                "{err:?}"
            );
        }
        // The wrong value type.
        let err = apply(
            &mut d,
            &Operation::SetProperty {
                node: node.clone(),
                path: PropertyPath::FramePatternTransform,
                value: Value::Bool(true),
            },
        )
        .expect_err("type");
        assert!(matches!(err, OperationError::TypeMismatch { .. }));
        apply(&mut d, &set.inverse).unwrap();
    }
}

#[test]
fn a_pattern_swatch_spec_reads_back_from_json__feat__color_swatches_pattern_paint() {
    // The wire spelling scripts and plugins write.
    let json = r#"{"spec":{"space":"","value":[],"name":"Grid","pattern":{"width":8,"height":8,
        "tileType":"HexByColumn","items":[{"anchors":[{"anchor":[0,0],"left":[0,0],"right":[0,0]},
        {"anchor":[4,0],"left":[4,0],"right":[4,0]},{"anchor":[4,4],"left":[4,4],"right":[4,4]}],
        "fill":{"space":"RGB","value":[0,128,255]}}]}}}"#;
    let v: serde_json::Value = serde_json::from_str(json).unwrap();
    let spec: SwatchSpec = serde_json::from_value(v["spec"].clone()).unwrap();
    let mut d = doc();
    let applied = apply(&mut d, &Operation::CreateSwatch { spec }).unwrap();
    let Operation::CreateSwatch { spec } = applied.op else {
        unreachable!()
    };
    let p = &d.palette.patterns[spec.self_id.as_deref().unwrap()];
    assert_eq!(p.layout.kind, paged_model::PatternTileKind::HexByColumn);
    assert_eq!(p.items[0].anchors.len(), 3);
}
