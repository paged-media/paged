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

//! Engine ADR 1007 — paint model v2 through the canvas model: the stop
//! fields and the conic kind read back through `gradientDetail` and undo
//! exactly; the stroke gradient mode sets, reads and undoes; `.paged`
//! keeps all of it; and the IDML export lowers what it can (a feather for
//! an inserted frame's fading fill, unnamed colours for inline stops) and
//! names the rest.
#![allow(non_snake_case)]

use std::io::Write;

use paged_canvas::{
    channel::Mutation, element_selection::ElementId, CanvasModel, CanvasOptions, PageId,
};
use paged_mutate::{GradientSpec, GradientStopSpec, PropertyPath, StopColorSpec, Value};

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
    CanvasModel::load("paint-v2", &idml(), CanvasOptions::default()).expect("load")
}

fn stop(color: &str, at: f32, opacity: Option<f32>) -> GradientStopSpec {
    GradientStopSpec {
        stop_color: color.into(),
        location_pct: at,
        midpoint_pct: None,
        opacity_pct: opacity,
        color: None,
    }
}

fn edit(m: &mut CanvasModel, id: &str, kind: &str, stops: Vec<GradientStopSpec>) {
    m.apply_mutation(&Mutation::EditGradient {
        gradient_id: id.into(),
        spec: GradientSpec {
            self_id: Some(id.into()),
            name: Some("Ramp".into()),
            kind: kind.into(),
            stops,
        },
    })
    .expect("editGradient");
}

fn rect() -> ElementId {
    ElementId::Rectangle("r1".into())
}

fn set(m: &mut CanvasModel, id: &ElementId, path: PropertyPath, value: Value) {
    m.apply_mutation(&Mutation::SetElementProperty {
        element_id: id.clone(),
        path,
        value,
    })
    .expect("set");
}

fn read(m: &CanvasModel, id: &ElementId, path: PropertyPath) -> Option<Value> {
    m.element_properties(id)
        .expect("element answers properties")
        .entries
        .into_iter()
        .find(|e| e.path == path)
        .and_then(|e| e.value)
}

fn new_losses(m: &CanvasModel, clean: &[String]) -> Vec<String> {
    m.idml_export_losses()
        .into_iter()
        .filter(|l| !clean.contains(l))
        .collect()
}

#[test]
fn opacity_inline_and_conic_read_back_and_undo__feat__color_swatches_paint_v2() {
    let mut m = load();
    let mut inline = stop("", 0.0, None);
    inline.color = Some(StopColorSpec {
        space: "RGB".into(),
        value: vec![255.0, 0.0, 0.0],
    });
    edit(
        &mut m,
        "Gradient/Ramp",
        "Conic",
        vec![inline, stop("Color/Sky", 100.0, Some(25.0))],
    );
    let d = m.gradient_detail("Gradient/Ramp").expect("detail");
    assert_eq!(d.kind, "conic");
    assert_eq!(d.stops[0].stop_color_ref, "");
    assert_eq!(d.stops[0].resolved_rgb_hex.to_lowercase(), "#ff0000");
    assert_eq!(
        d.stops[0].color.as_ref().map(|c| c.space.as_str()),
        Some("RGB")
    );
    assert_eq!(d.stops[1].opacity_pct, Some(25.0));
    assert_eq!(d.stops[0].opacity_pct, None);
    m.undo().expect("undo");
    let d = m.gradient_detail("Gradient/Ramp").expect("detail");
    assert_eq!(d.kind, "linear");
    assert_eq!(d.stops[0].stop_color_ref, "Color/Sun");
    assert!(d
        .stops
        .iter()
        .all(|s| s.opacity_pct.is_none() && s.color.is_none()));
}

#[test]
fn an_opacity_out_of_range_is_clamped_and_100_is_stored_as_absent__feat__color_swatches_paint_v2() {
    let mut m = load();
    edit(
        &mut m,
        "Gradient/Ramp",
        "Linear",
        vec![
            stop("Color/Sun", 0.0, Some(140.0)),
            stop("Color/Sky", 100.0, Some(-5.0)),
        ],
    );
    let d = m.gradient_detail("Gradient/Ramp").expect("detail");
    assert_eq!(d.stops[0].opacity_pct, None, "100 or more is opaque");
    assert_eq!(d.stops[1].opacity_pct, Some(0.0));
}

#[test]
fn the_stroke_gradient_mode_sets_reads_and_undoes__feat__color_swatches_paint_v2() {
    let mut m = load();
    assert_eq!(
        read(&m, &rect(), PropertyPath::FrameGradientStrokeMode),
        Some(Value::Text("Within".into()))
    );
    set(
        &mut m,
        &rect(),
        PropertyPath::FrameGradientStrokeMode,
        Value::Text("Along".into()),
    );
    assert_eq!(
        read(&m, &rect(), PropertyPath::FrameGradientStrokeMode),
        Some(Value::Text("Along".into()))
    );
    let refused = m.apply_mutation(&Mutation::SetElementProperty {
        element_id: rect(),
        path: PropertyPath::FrameGradientStrokeMode,
        value: Value::Text("Sideways".into()),
    });
    assert!(refused.is_err(), "an unknown mode is refused");
    m.undo().expect("undo");
    assert_eq!(
        read(&m, &rect(), PropertyPath::FrameGradientStrokeMode),
        Some(Value::Text("Within".into()))
    );
}

#[test]
fn paint_v2_survives_paged__feat__color_swatches_paint_v2() {
    let mut m = load();
    edit(
        &mut m,
        "Gradient/Ramp",
        "Conic",
        vec![
            stop("Color/Sun", 0.0, None),
            stop("Color/Sky", 100.0, Some(0.0)),
        ],
    );
    set(
        &mut m,
        &rect(),
        PropertyPath::FrameGradientStrokeMode,
        Value::Text("Across".into()),
    );
    m.refresh_model_part().expect("refresh model part");
    let bytes = m
        .export_paged(paged_canvas::channel::PROTOCOL_VERSION.0)
        .expect("export .paged");
    let back =
        CanvasModel::load("paint-v2-back", &bytes, CanvasOptions::default()).expect("reload");
    let d = back.gradient_detail("Gradient/Ramp").expect("detail");
    assert_eq!(d.kind, "conic");
    assert_eq!(d.stops[1].opacity_pct, Some(0.0));
    assert_eq!(
        read(&back, &rect(), PropertyPath::FrameGradientStrokeMode),
        Some(Value::Text("Across".into()))
    );
}

#[test]
fn the_idml_export_names_what_it_cannot_carry__feat__color_swatches_paint_v2() {
    let mut m = load();
    let clean = m.idml_export_losses();
    // A source frame's fading fill: the patch lane does not rewrite a
    // source item's effects, so no feather reaches the file — a loss.
    edit(
        &mut m,
        "Gradient/Ramp",
        "Linear",
        vec![
            stop("Color/Sun", 0.0, None),
            stop("Color/Sky", 100.0, Some(0.0)),
        ],
    );
    let l = new_losses(&m, &clean);
    assert!(
        l.iter()
            .any(|l| l.contains("opacity stops") && l.contains("`r1`")),
        "{l:?}"
    );
    // Conic and a mapped stroke are always named.
    edit(
        &mut m,
        "Gradient/Ramp",
        "Conic",
        vec![stop("Color/Sun", 0.0, None), stop("Color/Sky", 100.0, None)],
    );
    set(
        &mut m,
        &rect(),
        PropertyPath::FrameStrokeColor,
        Value::ColorRef(Some("Gradient/Ramp".into())),
    );
    set(
        &mut m,
        &rect(),
        PropertyPath::FrameStrokeWeight,
        Value::Length(Some(8.0)),
    );
    set(
        &mut m,
        &rect(),
        PropertyPath::FrameGradientStrokeMode,
        Value::Text("Along".into()),
    );
    let l = new_losses(&m, &clean);
    assert!(
        l.iter()
            .any(|l| l.contains("conic gradient `Gradient/Ramp`")),
        "{l:?}"
    );
    assert!(l.iter().any(|l| l.contains("runs along")), "{l:?}");
    assert!(l.iter().all(|l| l.contains(".paged")), "{l:?}");
}

#[test]
fn an_inserted_frames_fading_fill_exports_as_a_gradient_feather__feat__color_swatches_paint_v2() {
    let mut m = load();
    let page = PageId(m.pages()[0].self_id.clone());
    let id = m
        .apply_mutation(&Mutation::InsertFrame {
            page_id: page,
            bounds: (60.0, 20.0, 140.0, 380.0),
        })
        .expect("insert")
        .created_id
        .expect("created");
    m.apply_mutation(&Mutation::CreateGradient {
        spec: GradientSpec {
            self_id: Some("Gradient/Fade".into()),
            name: Some("Fade".into()),
            kind: "Linear".into(),
            stops: vec![
                {
                    let mut s = stop("", 0.0, None);
                    s.color = Some(StopColorSpec {
                        space: "RGB".into(),
                        value: vec![0.0, 128.0, 255.0],
                    });
                    s
                },
                {
                    let mut s = stop("", 100.0, Some(0.0));
                    s.color = Some(StopColorSpec {
                        space: "RGB".into(),
                        value: vec![0.0, 128.0, 255.0],
                    });
                    s
                },
            ],
        },
    })
    .expect("createGradient");
    set(
        &mut m,
        &id,
        PropertyPath::FrameFillColor,
        Value::ColorRef(Some("Gradient/Fade".into())),
    );
    set(
        &mut m,
        &id,
        PropertyPath::FrameStrokeWeight,
        Value::Length(Some(0.0)),
    );
    let losses = m.idml_export_losses();
    let inserted = match &id {
        ElementId::TextFrame(s) | ElementId::Rectangle(s) => s.clone(),
        other => panic!("an inserted frame, not {other:?}"),
    };
    assert!(
        !losses.iter().any(|l| l.contains(&format!("`{inserted}`"))),
        "the fade is carried: {losses:?}"
    );
    assert!(
        !losses.iter().any(|l| l.contains("Gradient/Fade")),
        "and its inline colours: {losses:?}"
    );
    let twin = idml_import::import_idml_doc(&m.export_idml().expect("export")).expect("re-import");
    let g = &twin.palette.gradients["Gradient/Fade"];
    let first = twin
        .palette
        .resolve(&g.stops[0].stop_color)
        .expect("an unnamed colour");
    assert_eq!(first.value, vec![0.0, 128.0, 255.0]);
    let feather = twin
        .spreads
        .iter()
        .flat_map(|s| s.spread.rectangles.iter().chain(std::iter::empty()))
        .chain(std::iter::empty())
        .find_map(|r| {
            (r.self_id.as_deref() == Some(inserted.as_str()))
                .then(|| r.effects.as_ref()?.gradient_feather.clone())
                .flatten()
        })
        .or_else(|| {
            twin.spreads.iter().find_map(|s| {
                s.spread
                    .text_frames
                    .iter()
                    .find(|f| f.self_id.as_deref() == Some(inserted.as_str()))
                    .and_then(|f| f.effects.as_ref()?.gradient_feather.clone())
            })
        })
        .expect("the frame carries a gradient feather");
    let alphas: Vec<f32> = feather.stops.iter().map(|s| s.alpha_pct).collect();
    assert_eq!(alphas, vec![100.0, 0.0]);
}
