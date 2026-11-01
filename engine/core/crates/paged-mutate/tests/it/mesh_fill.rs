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

//! Engine ADR 1048 — `FrameFillMesh` through the mutation layer: set on
//! each fillable kind with an exact inverse, clamped colour opacity, the
//! refusals (a line, a malformed spec, the wrong value type), and a
//! spec that round-trips through the model.
#![allow(non_snake_case)]

use std::path::PathBuf;

use paged_mutate::{
    apply, MeshColorSpec, MeshFillSpec, MeshGridSpec, MeshNodeSpec, NodeId, Operation,
    OperationError, PropertyPath, Value,
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

fn spec(opacity: Option<f32>) -> MeshFillSpec {
    let node = |x: f32, y: f32| MeshNodeSpec {
        point: [x, y],
        handles: [[x, y]; 4],
        color: MeshColorSpec {
            space: "CMYK".into(),
            value: vec![0.0, 100.0, 0.0, 0.0],
            opacity_pct: opacity,
        },
    };
    MeshFillSpec::Mesh {
        grids: vec![MeshGridSpec {
            rows: 1,
            cols: 1,
            nodes: vec![
                node(0.0, 0.0),
                node(10.0, 0.0),
                node(0.0, 10.0),
                node(10.0, 10.0),
            ],
            tensor: vec![],
        }],
    }
}

fn set(node: NodeId, value: Value) -> Operation {
    Operation::SetProperty {
        node,
        path: PropertyPath::FrameFillMesh,
        value,
    }
}

#[test]
fn a_mesh_fill_sets_and_inverts_on_every_fillable_kind__feat__color_swatches_mesh_freeform_gradients(
) {
    let mut d = doc();
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
    if let Some(id) = sp.text_frames.iter().find_map(|r| r.self_id.clone()) {
        nodes.push(NodeId::TextFrame(id));
    }
    assert!(nodes.len() >= 2, "the fixture has fillable frames");
    for node in nodes {
        let applied = apply(
            &mut d,
            &set(node.clone(), Value::FillMesh(Some(spec(None)))),
        )
        .unwrap_or_else(|e| panic!("{node:?}: {e:?}"));
        assert!(!applied.invalidation.frame_style.is_empty());
        let Operation::SetProperty { value, .. } = &applied.inverse else {
            panic!("a set inverts to a set")
        };
        assert_eq!(value, &Value::FillMesh(None), "{node:?} had no mesh");
        // Re-set: the inverse now carries the mesh it replaces.
        let again = apply(
            &mut d,
            &set(node.clone(), Value::FillMesh(Some(spec(Some(30.0))))),
        )
        .unwrap();
        let Operation::SetProperty { value, .. } = &again.inverse else {
            unreachable!()
        };
        assert_eq!(value, &Value::FillMesh(Some(spec(None))));
        apply(&mut d, &again.inverse).unwrap();
        apply(&mut d, &applied.inverse).unwrap();
    }
}

#[test]
fn opacity_is_clamped_and_100_is_stored_as_absent__feat__color_swatches_mesh_freeform_gradients() {
    let mut d = doc();
    let id = d.spreads[0].spread.rectangles[0].self_id.clone().unwrap();
    apply(
        &mut d,
        &set(
            NodeId::Rectangle(id.clone()),
            Value::FillMesh(Some(spec(Some(250.0)))),
        ),
    )
    .unwrap();
    let r = &d.spreads[0].spread.rectangles[0];
    let fill = r.fill_mesh.as_deref().unwrap();
    assert!(
        fill.colors().iter().all(|c| c.opacity_pct.is_none()),
        "100 is absent"
    );
    apply(
        &mut d,
        &set(
            NodeId::Rectangle(id),
            Value::FillMesh(Some(spec(Some(-5.0)))),
        ),
    )
    .unwrap();
    let fill = d.spreads[0].spread.rectangles[0]
        .fill_mesh
        .as_deref()
        .unwrap();
    assert!(fill.colors().iter().all(|c| c.opacity_pct == Some(0.0)));
}

#[test]
fn a_line_a_malformed_spec_and_a_wrong_type_are_refused__feat__color_swatches_mesh_freeform_gradients(
) {
    let mut d = doc();
    let sp = &d.spreads[0].spread;
    if let Some(id) = sp.graphic_lines.iter().find_map(|l| l.self_id.clone()) {
        let err = apply(
            &mut d,
            &set(NodeId::GraphicLine(id), Value::FillMesh(Some(spec(None)))),
        )
        .unwrap_err();
        assert!(
            matches!(err, OperationError::UnsupportedProperty { .. }),
            "{err:?}"
        );
    }
    let id = d.spreads[0].spread.rectangles[0].self_id.clone().unwrap();
    let MeshFillSpec::Mesh { mut grids } = spec(None) else {
        unreachable!()
    };
    grids[0].tensor = vec![[[0.0, 0.0]; 4]; 2];
    let err = apply(
        &mut d,
        &set(
            NodeId::Rectangle(id.clone()),
            Value::FillMesh(Some(MeshFillSpec::Mesh { grids })),
        ),
    )
    .unwrap_err();
    assert!(
        matches!(err, OperationError::InvalidValue { .. }),
        "{err:?}"
    );
    let err = apply(&mut d, &set(NodeId::Rectangle(id), Value::Bool(true))).unwrap_err();
    assert!(
        matches!(err, OperationError::TypeMismatch { .. }),
        "{err:?}"
    );
    assert!(d.spreads[0].spread.rectangles[0].fill_mesh.is_none());
}

#[test]
fn the_spec_round_trips_through_the_model__feat__color_swatches_mesh_freeform_gradients() {
    let s = spec(Some(20.0));
    let model = s.to_model().unwrap();
    assert_eq!(MeshFillSpec::from_model(&model), s);
    let json = serde_json::to_value(&s).unwrap();
    assert_eq!(json["kind"], "mesh");
    assert_eq!(json["grids"][0]["nodes"][0]["color"]["opacityPct"], 20.0);
}

#[test]
fn a_box_move_carries_the_mesh_and_undoes_exactly__feat__color_swatches_mesh_freeform_gradients() {
    let mut d = doc();
    // A plain box rectangle (no anchors): drawn from its bounds.
    let r = d.spreads[0]
        .spread
        .rectangles
        .iter()
        .position(|r| {
            paged_model::mesh::path_is_plain_box(&r.anchors, &r.subpath_starts, &r.subpath_open)
        })
        .expect("a box rectangle");
    let rect = &d.spreads[0].spread.rectangles[r];
    let id = rect.self_id.clone().unwrap();
    let b = rect.bounds;
    let old = [b.top, b.left, b.bottom, b.right];
    let node = NodeId::Rectangle(id);
    let node_at = |x: f32, y: f32| MeshNodeSpec {
        point: [x, y],
        handles: [[x, y]; 4],
        color: MeshColorSpec {
            space: "RGB".into(),
            value: vec![10.0, 20.0, 30.0],
            opacity_pct: None,
        },
    };
    let spec = MeshFillSpec::Mesh {
        grids: vec![MeshGridSpec {
            rows: 1,
            cols: 1,
            nodes: vec![
                node_at(old[1], old[0]),
                node_at(old[3], old[0]),
                node_at(old[1], old[2]),
                node_at(old[3], old[2]),
            ],
            tensor: vec![],
        }],
    };
    apply(
        &mut d,
        &set(node.clone(), Value::FillMesh(Some(spec.clone()))),
    )
    .unwrap();
    // Move right by 13.3 and down by 7.7, and double the width.
    let w = old[3] - old[1];
    let new = [
        old[0] + 7.7,
        old[1] + 13.3,
        old[2] + 7.7,
        old[1] + 13.3 + 2.0 * w,
    ];
    let moved = apply(
        &mut d,
        &Operation::SetProperty {
            node: node.clone(),
            path: PropertyPath::FrameBounds,
            value: Value::Bounds(new),
        },
    )
    .unwrap();
    let fill = d.spreads[0].spread.rectangles[r]
        .fill_mesh
        .as_deref()
        .unwrap();
    let paged_model::MeshFill::Mesh(m) = fill else {
        unreachable!()
    };
    let p = m.grids[0].nodes[3].point;
    assert!(
        (p[0] - new[3]).abs() < 1e-3 && (p[1] - new[2]).abs() < 1e-3,
        "{p:?} vs {new:?}"
    );
    // One undo: bounds and the mesh exactly as they were.
    apply(&mut d, &moved.inverse).unwrap();
    let back = &d.spreads[0].spread.rectangles[r];
    assert_eq!(
        [
            back.bounds.top,
            back.bounds.left,
            back.bounds.bottom,
            back.bounds.right
        ],
        old
    );
    assert_eq!(
        MeshFillSpec::from_model(back.fill_mesh.as_deref().unwrap()),
        spec,
        "the mesh comes back bit for bit"
    );
}
