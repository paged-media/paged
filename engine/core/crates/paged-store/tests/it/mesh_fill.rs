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

//! Engine ADR 1048 — a frame's gradient mesh or freeform gradient rides
//! the native model as written, and a document without one writes no key
//! (its bytes and state hash are those of a document saved before meshes).

use idml_import::{Bounds, Oval, Rectangle, Spread};
use paged_model::{FreeformGradient, FreeformPoint, GradientMesh, MeshColor, MeshFill, MeshGrid};
use paged_scene::{Document, ParsedSpread};

fn bounds() -> Bounds {
    Bounds {
        top: 10.0,
        left: 10.0,
        bottom: 60.0,
        right: 110.0,
    }
}

fn mesh() -> MeshFill {
    let mut g = MeshGrid::rect([10.0, 10.0, 110.0, 60.0], &MeshColor::rgb(255.0, 0.0, 0.0));
    g.nodes[3].color.opacity_pct = Some(40.0);
    MeshFill::Mesh(GradientMesh { grids: vec![g] })
}

fn freeform() -> MeshFill {
    MeshFill::Freeform(FreeformGradient {
        points: vec![
            FreeformPoint {
                point: [20.0, 20.0],
                color: MeshColor::rgb(0.0, 0.0, 255.0),
                spread_pct: Some(10.0),
            },
            FreeformPoint {
                point: [90.0, 50.0],
                color: MeshColor::rgb(0.0, 255.0, 0.0),
                spread_pct: None,
            },
        ],
        lines: vec![vec![0, 1]],
    })
}

fn doc(with: bool) -> Document {
    let mut spread = Spread::default();
    spread.rectangles.push(Rectangle {
        fill_mesh: with.then(|| Box::new(mesh())),
        ..Rectangle::new("rect", bounds())
    });
    spread.ovals.push(Oval {
        fill_mesh: with.then(|| Box::new(freeform())),
        ..Oval::new("oval", bounds())
    });
    Document {
        spreads: vec![ParsedSpread {
            src: "Spreads/Spread_s1.xml".into(),
            spread,
        }],
        ..Default::default()
    }
}

#[test]
#[allow(non_snake_case)]
fn a_mesh_fill_round_trips_through_the_native_model__feat__color_swatches_mesh_freeform_gradients()
{
    let back = paged_store::from_bytes(&paged_store::to_bytes(&doc(true)).unwrap()).unwrap();
    let s = &back.spreads[0].spread;
    assert_eq!(s.rectangles[0].fill_mesh.as_deref(), Some(&mesh()));
    assert_eq!(s.ovals[0].fill_mesh.as_deref(), Some(&freeform()));
    assert_eq!(back.canonical_hash(), doc(true).canonical_hash());
}

#[test]
#[allow(non_snake_case)]
fn a_document_without_a_mesh_writes_no_key__feat__color_swatches_mesh_freeform_gradients() {
    let bytes = paged_store::to_bytes(&doc(false)).unwrap();
    assert!(!String::from_utf8_lossy(&bytes).contains("fill_mesh"));
    let back = paged_store::from_bytes(&bytes).expect("loads");
    assert!(back.spreads[0].spread.rectangles[0].fill_mesh.is_none());
    assert_eq!(doc(false).canonical_hash(), back.canonical_hash());
    assert_ne!(doc(false).canonical_hash(), doc(true).canonical_hash());
}
