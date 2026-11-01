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

//! Engine ADR 1048 — a frame's gradient mesh or freeform gradient
//! through the canvas model: set, read back and undone as one step;
//! refused when malformed or on a line; drawn; kept by `.paged`; and on
//! IDML export carried in the frame's label, which the import restores,
//! with the loss named.
#![allow(non_snake_case)]

use std::io::Write;

use paged_canvas::{channel::Mutation, element_selection::ElementId, CanvasModel, CanvasOptions};
use paged_mutate::{
    FreeformPointSpec, MeshColorSpec, MeshFillSpec, MeshGridSpec, MeshNodeSpec, PropertyPath, Value,
};

/// A 400 × 300 page with the source rectangle `r1` (x 100..300, y
/// 50..250) filled with `Gradient/Ramp` (Sun → Sky).
fn idml() -> Vec<u8> {
    use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};
    let mut zip = ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let o = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    zip.start_file("mimetype", o).unwrap();
    zip.write_all(b"application/vnd.adobe.indesign-idml-package")
        .unwrap();
    zip.start_file("designmap.xml", o).unwrap();
    zip.write_all(
        br#"<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <idPkg:Graphic src="Resources/Graphic.xml"/>
  <idPkg:Spread src="Spreads/Spread_sp1.xml"/>
</Document>"#,
    )
    .unwrap();
    zip.start_file("Resources/Graphic.xml", o).unwrap();
    zip.write_all(
        br#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Graphic xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <Graphic>
    <Color Self="Color/Sun" Name="Sun" Space="RGB" ColorValue="255 200 80"/>
    <Color Self="Color/Sky" Name="Sky" Space="RGB" ColorValue="60 120 220"/>
    <Gradient Self="Gradient/Ramp" Name="Ramp" Type="Linear">
      <GradientStop StopColor="Color/Sun" Location="0"/>
      <GradientStop StopColor="Color/Sky" Location="100"/>
    </Gradient>
  </Graphic>
</idPkg:Graphic>"#,
    )
    .unwrap();
    zip.start_file("Spreads/Spread_sp1.xml", o).unwrap();
    zip.write_all(
        br#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Spread xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <Spread Self="sp1">
    <Page Self="p1" GeometricBounds="0 0 300 400"/>
    <Rectangle Self="r1" GeometricBounds="50 100 250 300" FillColor="Gradient/Ramp" StrokeWeight="0"/>
  </Spread>
</idPkg:Spread>"#,
    )
    .unwrap();
    zip.finish().unwrap().into_inner()
}

fn load() -> CanvasModel {
    CanvasModel::load("mesh", &idml(), CanvasOptions::default()).expect("load")
}

fn rect() -> ElementId {
    ElementId::Rectangle("r1".into())
}

fn rgb(r: f32, g: f32, b: f32) -> MeshColorSpec {
    MeshColorSpec {
        space: "RGB".into(),
        value: vec![r, g, b],
        opacity_pct: None,
    }
}

/// A one-patch mesh over the rectangle's box, straight edges.
fn mesh() -> MeshFillSpec {
    let node = |x: f32, y: f32, c: MeshColorSpec| {
        let third = |a: f32, b: f32| a + (b - a) / 3.0;
        let (ox, oy) = (
            if x < 200.0 { 300.0 } else { 100.0 },
            if y < 150.0 { 250.0 } else { 50.0 },
        );
        let (l, r) = if x < 200.0 {
            ([x, y], [third(x, ox), y])
        } else {
            ([third(x, ox), y], [x, y])
        };
        let (u, d) = if y < 150.0 {
            ([x, y], [x, third(y, oy)])
        } else {
            ([x, third(y, oy)], [x, y])
        };
        MeshNodeSpec {
            point: [x, y],
            handles: [l, r, u, d],
            color: c,
        }
    };
    MeshFillSpec::Mesh {
        grids: vec![MeshGridSpec {
            rows: 1,
            cols: 1,
            nodes: vec![
                node(100.0, 50.0, rgb(255.0, 0.0, 0.0)),
                node(300.0, 50.0, rgb(0.0, 255.0, 0.0)),
                node(100.0, 250.0, rgb(0.0, 0.0, 255.0)),
                node(300.0, 250.0, rgb(255.0, 255.0, 0.0)),
            ],
            tensor: vec![],
        }],
    }
}

fn digests(m: &CanvasModel) -> Vec<u64> {
    m.built().pages.iter().map(|p| p.list.digest()).collect()
}

fn set(m: &mut CanvasModel, id: &ElementId, value: Value) -> Result<(), String> {
    m.apply_mutation(&Mutation::SetElementProperty {
        element_id: id.clone(),
        path: PropertyPath::FrameFillMesh,
        value,
    })
    .map(|_| ())
    .map_err(|e| format!("{e:?}"))
}

fn read(m: &CanvasModel, id: &ElementId) -> Option<Value> {
    m.element_properties(id)
        .expect("element answers properties")
        .entries
        .into_iter()
        .find(|e| e.path == PropertyPath::FrameFillMesh)
        .and_then(|e| e.value)
}

#[test]
fn a_mesh_sets_reads_and_undoes_in_one_step__feat__color_swatches_mesh_freeform_gradients() {
    let mut m = load();
    assert_eq!(read(&m, &rect()), Some(Value::FillMesh(None)));
    let before = digests(&m);
    set(&mut m, &rect(), Value::FillMesh(Some(mesh()))).expect("set");
    assert_eq!(read(&m, &rect()), Some(Value::FillMesh(Some(mesh()))));
    assert_ne!(digests(&m), before, "the mesh draws");
    // A freeform gradient replaces it; one undo brings the mesh back.
    let ff = MeshFillSpec::Freeform {
        points: vec![FreeformPointSpec {
            point: [150.0, 100.0],
            color: rgb(0.0, 0.0, 255.0),
            spread_pct: Some(10.0),
        }],
        lines: vec![],
    };
    set(&mut m, &rect(), Value::FillMesh(Some(ff.clone()))).expect("set freeform");
    assert_eq!(read(&m, &rect()), Some(Value::FillMesh(Some(ff))));
    m.undo().expect("undo");
    assert_eq!(read(&m, &rect()), Some(Value::FillMesh(Some(mesh()))));
    m.undo().expect("undo");
    assert_eq!(read(&m, &rect()), Some(Value::FillMesh(None)));
    assert_eq!(digests(&m), before, "undo restores the drawing");
}

#[test]
fn a_malformed_mesh_or_a_line_is_refused__feat__color_swatches_mesh_freeform_gradients() {
    let mut m = load();
    let MeshFillSpec::Mesh { mut grids } = mesh() else {
        unreachable!()
    };
    grids[0].nodes.pop();
    let err = set(
        &mut m,
        &rect(),
        Value::FillMesh(Some(MeshFillSpec::Mesh { grids })),
    )
    .unwrap_err();
    assert!(
        err.contains("invalid value") && err.contains("4 nodes"),
        "{err}"
    );
    let bad_line = MeshFillSpec::Freeform {
        points: vec![FreeformPointSpec {
            point: [150.0, 100.0],
            color: rgb(0.0, 0.0, 255.0),
            spread_pct: None,
        }],
        lines: vec![vec![0, 3]],
    };
    let err = set(&mut m, &rect(), Value::FillMesh(Some(bad_line))).unwrap_err();
    assert!(err.contains("does not exist"), "{err}");
    let mut odd = mesh();
    if let MeshFillSpec::Mesh { grids } = &mut odd {
        grids[0].nodes[0].color = MeshColorSpec {
            space: "HSB".into(),
            value: vec![1.0, 2.0, 3.0],
            opacity_pct: None,
        };
    }
    assert!(set(&mut m, &rect(), Value::FillMesh(Some(odd))).is_err());
    assert_eq!(
        read(&m, &rect()),
        Some(Value::FillMesh(None)),
        "nothing applied"
    );
}

#[test]
fn a_mesh_survives_paged__feat__color_swatches_mesh_freeform_gradients() {
    let mut m = load();
    set(&mut m, &rect(), Value::FillMesh(Some(mesh()))).expect("set");
    m.refresh_model_part().expect("refresh model part");
    let bytes = m
        .export_paged(paged_canvas::channel::PROTOCOL_VERSION.0)
        .expect("export .paged");
    let back = CanvasModel::load("mesh-back", &bytes, CanvasOptions::default()).expect("reload");
    assert_eq!(read(&back, &rect()), Some(Value::FillMesh(Some(mesh()))));
}

#[test]
fn the_idml_export_keeps_the_mesh_in_a_label_and_names_the_loss__feat__color_swatches_mesh_freeform_gradients(
) {
    let mut m = load();
    let clean = m.idml_export_losses();
    set(&mut m, &rect(), Value::FillMesh(Some(mesh()))).expect("set");
    let losses: Vec<String> = m
        .idml_export_losses()
        .into_iter()
        .filter(|l| !clean.contains(l))
        .collect();
    assert_eq!(losses.len(), 1, "{losses:?}");
    assert!(
        losses[0].contains("gradient mesh of rectangle `r1`")
            && losses[0].contains("label")
            && losses[0].contains("restores"),
        "{losses:?}"
    );
    let bytes = m.export_idml().expect("export idml");
    // InDesign sees the frame's swatch and a label it keeps.
    let back = CanvasModel::load("mesh-idml", &bytes, CanvasOptions::default()).expect("reload");
    assert_eq!(
        read(&back, &rect()),
        Some(Value::FillMesh(Some(mesh()))),
        "a paged import restores the mesh from the label"
    );
    let doc = idml_import::import_idml_doc(&bytes).expect("import");
    let s = &doc.spreads[0].spread;
    assert!(s.rectangles[0].fill_mesh.is_some());
    assert!(
        !s.labels
            .get("r1")
            .is_some_and(|l| l.iter().any(|(k, _)| k == paged_model::MESH_FILL_LABEL_KEY)),
        "the label entry is consumed"
    );
    // The file itself carries the label (InDesign keeps a label).
    let archive = idml_import::open_source_archive(&bytes).expect("archive");
    let spread_xml = String::from_utf8_lossy(
        archive
            .entry("Spreads/Spread_sp1.xml")
            .expect("spread part"),
    )
    .into_owned();
    assert!(spread_xml.contains("paged:fillMesh"), "{spread_xml}");
    assert!(spread_xml.contains("FillColor=\"Gradient/Ramp\""));
}
