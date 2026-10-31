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

//! Engine ADR 1043 — `frameAppearance` through the canvas model: an
//! imported item reads the empty list; a write is one undo step that
//! undoes to the exact state hash; a per-layer write edits one layer; the
//! layers draw as paths of their own (a layer with a blend mode or an
//! opacity in a group of its own); a refusal changes nothing; the
//! appearance survives `.paged` and an IDML round trip (baked to a group,
//! reported, restored on re-import).

use std::io::Write;

use paged_canvas::{channel::Mutation, CanvasModel, CanvasOptions, PageId};
use paged_compose::{BlendMode, DisplayCommand};
use paged_mutate::appearance_wire::{PaintLayerKind, PaintLayerSpec};
use paged_mutate::Value;
use paged_wire::{ElementId, VirtualTarget};

fn idml() -> Vec<u8> {
    let mut buf = Vec::new();
    {
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        let mut put = |name: &str, body: &[u8]| {
            zip.start_file(name, opts).unwrap();
            zip.write_all(body).unwrap();
        };
        put("mimetype", b"application/vnd.adobe.indesign-idml-package");
        put(
            "designmap.xml",
            br#"<?xml version="1.0" encoding="UTF-8"?>
<Document DOMVersion="13.1" Self="d1">
<idPkg:Graphic src="Resources/Graphic.xml" xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"/>
<idPkg:Spread src="Spreads/Spread_s1.xml" xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"/>
</Document>"#,
        );
        put(
            "Resources/Graphic.xml",
            br#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Graphic xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <Color Self="Color/Black" Model="Process" Space="CMYK" ColorValue="0 0 0 100" Name="Black"/>
  <Color Self="Color/Red" Model="Process" Space="RGB" ColorValue="255 0 0" Name="Red"/>
  <Color Self="Color/Blue" Model="Process" Space="RGB" ColorValue="0 0 255" Name="Blue"/>
  <Color Self="Color/Yellow" Model="Process" Space="RGB" ColorValue="255 255 0" Name="Yellow"/>
</idPkg:Graphic>"#,
        );
        put(
            "Spreads/Spread_s1.xml",
            br#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Spread xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="13.1">
<Spread Self="s1" PageCount="1">
<Page Self="p1" Name="1" GeometricBounds="0 0 792 612" ItemTransform="1 0 0 1 0 0"/>
<Rectangle Self="r0" GeometricBounds="20 20 40 40" FillColor="Color/Black" StrokeWeight="0" ItemTransform="1 0 0 1 0 0"/>
<Rectangle Self="r1" GeometricBounds="50 50 200 200" FillColor="Color/Yellow" StrokeColor="Color/Black" StrokeWeight="2" ItemTransform="1 0 0 1 0 0"/>
<Oval Self="o1" GeometricBounds="300 300 400 400" FillColor="Color/Black" StrokeWeight="0" ItemTransform="1 0 0 1 0 0"/>
</Spread></idPkg:Spread>"#,
        );
        zip.finish().unwrap();
    }
    buf
}

fn load() -> CanvasModel {
    CanvasModel::load("appearance", &idml(), CanvasOptions::default()).expect("load")
}

fn rect() -> VirtualTarget {
    VirtualTarget::Element {
        element_id: ElementId::Rectangle("r1".into()),
    }
}

fn layers(m: &CanvasModel) -> Vec<PaintLayerSpec> {
    match m.get_property(&rect(), "frameAppearance") {
        Ok(Value::Appearance { layers, .. }) => layers,
        other => panic!("frameAppearance: {other:?}"),
    }
}

fn set(m: &mut CanvasModel, layers: Vec<PaintLayerSpec>) -> Result<(), String> {
    m.apply_mutation(&Mutation::Set {
        address: rect().into(),
        path: "frameAppearance".to_string(),
        value: Value::Appearance { layers, prev: None },
    })
    .map(|_| ())
    .map_err(|e| format!("{e:?}"))
}

fn fill(color: &str) -> PaintLayerSpec {
    PaintLayerSpec {
        color: Some(color.into()),
        ..PaintLayerSpec::new(PaintLayerKind::Fill)
    }
}

fn stroke(color: &str, weight: f32) -> PaintLayerSpec {
    PaintLayerSpec {
        color: Some(color.into()),
        weight: Some(weight),
        ..PaintLayerSpec::new(PaintLayerKind::Stroke)
    }
}

/// Fill (yellow, the frame's own) — red at 50 % Multiply — the frame's
/// black stroke — a blue 8 pt stroke.
fn three_paints() -> Vec<PaintLayerSpec> {
    let mut red = fill("Color/Red");
    red.opacity_pct = Some(50.0);
    red.blend_mode = Some("Multiply".into());
    vec![
        PaintLayerSpec::new(PaintLayerKind::FrameFill),
        red,
        PaintLayerSpec::new(PaintLayerKind::FrameStroke),
        stroke("Color/Blue", 8.0),
    ]
}

fn page_list(m: &CanvasModel) -> &paged_compose::DisplayList {
    let page = PageId(m.pages()[0].self_id.clone());
    m.display_list_for_page(&page).expect("display list")
}

fn multiply_groups(m: &CanvasModel) -> usize {
    page_list(m)
        .commands
        .iter()
        .filter(|c| {
            matches!(
                c,
                DisplayCommand::BeginBlendGroup {
                    blend_mode: BlendMode::Multiply,
                    ..
                }
            )
        })
        .count()
}

fn strokes(m: &CanvasModel) -> usize {
    page_list(m)
        .commands
        .iter()
        .filter(|c| matches!(c, DisplayCommand::StrokePath { .. }))
        .count()
}

#[test]
#[allow(non_snake_case)]
fn an_imported_item_reads_an_empty_appearance__feat__frames_paths_native_appearance() {
    let m = load();
    assert!(layers(&m).is_empty());
}

#[test]
#[allow(non_snake_case)]
fn a_write_draws_every_layer_and_undoes_exactly__feat__frames_paths_native_appearance() {
    let mut m = load();
    let h0 = m.current_state_hash();
    let strokes0 = strokes(&m);
    // The placeholders alone, in the implied order, are the frame as it was.
    set(
        &mut m,
        vec![
            PaintLayerSpec::new(PaintLayerKind::FrameFill),
            PaintLayerSpec::new(PaintLayerKind::FrameStroke),
        ],
    )
    .unwrap();
    assert!(layers(&m).is_empty());
    assert_eq!(m.current_state_hash(), h0);

    set(&mut m, three_paints()).unwrap();
    let h1 = m.current_state_hash();
    assert_ne!(h1, h0);
    let read = layers(&m);
    assert_eq!(read.len(), 4);
    assert_eq!(read[1].blend_mode.as_deref(), Some("Multiply"));
    assert_eq!(read[3].weight, Some(8.0));
    assert_eq!(multiply_groups(&m), 1, "the red layer is a Multiply group");
    assert_eq!(strokes(&m), strokes0 + 1, "the blue stroke draws");

    m.undo().expect("undo");
    assert_eq!(m.current_state_hash(), h0);
    assert_eq!(multiply_groups(&m), 0);
    m.redo().expect("redo");
    assert_eq!(m.current_state_hash(), h1);
}

#[test]
#[allow(non_snake_case)]
fn a_layer_write_edits_one_layer__feat__frames_paths_native_appearance() {
    let mut m = load();
    set(&mut m, three_paints()).unwrap();
    let h1 = m.current_state_hash();
    let mut blue = layers(&m)[3].clone();
    blue.weight = Some(3.0);
    blue.alignment = Some("OutsideAlignment".into());
    m.apply_mutation(&Mutation::Set {
        address: rect().into(),
        path: "frameAppearanceLayer".into(),
        value: Value::AppearanceLayer {
            index: 3,
            layer: blue,
        },
    })
    .expect("layer write");
    let read = layers(&m);
    assert_eq!(read[3].weight, Some(3.0));
    assert_eq!(read[3].alignment.as_deref(), Some("OutsideAlignment"));
    // Appending: one past the end.
    m.apply_mutation(&Mutation::Set {
        address: rect().into(),
        path: "frameAppearanceLayer".into(),
        value: Value::AppearanceLayer {
            index: 4,
            layer: fill("Color/Black"),
        },
    })
    .expect("append");
    assert_eq!(layers(&m).len(), 5);
    m.undo().expect("undo append");
    m.undo().expect("undo layer write");
    assert_eq!(m.current_state_hash(), h1);
}

#[test]
#[allow(non_snake_case)]
fn refusals_change_nothing__feat__frames_paths_native_appearance() {
    let mut m = load();
    let h0 = m.current_state_hash();
    let twice = vec![
        PaintLayerSpec::new(PaintLayerKind::FrameFill),
        PaintLayerSpec::new(PaintLayerKind::FrameFill),
    ];
    let e = set(&mut m, twice).unwrap_err();
    assert!(e.contains("listed twice"), "{e}");
    let mut shadowed = fill("Color/Red");
    shadowed.effects = vec![paged_mutate::operation::EffectEntrySpec::new(
        paged_mutate::operation::EffectKind::DropShadow,
    )];
    let e = set(&mut m, vec![shadowed]).unwrap_err();
    assert!(e.contains("stack-only"), "{e}");
    let e = m
        .apply_mutation(&Mutation::Set {
            address: rect().into(),
            path: "frameAppearanceLayer".into(),
            value: Value::AppearanceLayer {
                index: 7,
                layer: fill("Color/Red"),
            },
        })
        .map(|_| ())
        .unwrap_err();
    assert!(format!("{e:?}").contains("past the end"), "{e:?}");
    assert_eq!(m.current_state_hash(), h0);
}

#[test]
#[allow(non_snake_case)]
fn the_appearance_survives_paged_and_idml__feat__frames_paths_native_appearance() {
    let mut m = load();
    let clean = m.idml_export_losses();
    set(&mut m, three_paints()).unwrap();
    let want = serde_json::to_string(&layers(&m)).unwrap();

    // `.paged`.
    m.refresh_model_part().expect("refresh model part");
    let bytes = m
        .export_paged(paged_canvas::channel::PROTOCOL_VERSION.0)
        .expect("export .paged");
    let reloaded = CanvasModel::load("reloaded", &bytes, CanvasOptions::default()).expect("reload");
    assert_eq!(serde_json::to_string(&layers(&reloaded)).unwrap(), want);

    // IDML: reported once, baked to a group, restored on re-import.
    let losses: Vec<String> = m
        .idml_export_losses()
        .into_iter()
        .filter(|l| !clean.contains(l))
        .collect();
    assert_eq!(losses.len(), 1, "{losses:?}");
    assert!(
        losses[0].contains("`r1`") && losses[0].contains("paged:appearance"),
        "{}",
        losses[0]
    );
    let idml = m.export_idml().expect("export idml");
    let twin = idml_import::import_idml_doc(&idml).expect("twin");
    let sp = &twin.spreads[0].spread;
    // The reader turns the baked group back into the appearance.
    let restored = sp
        .rectangles
        .iter()
        .find(|r| r.self_id.as_deref() == Some("r1"));
    assert!(restored.is_some_and(|r| r.appearance.len() == 4));
    let again = CanvasModel::load("again", &idml, CanvasOptions::default()).expect("re-import");
    assert_eq!(serde_json::to_string(&layers(&again)).unwrap(), want);
    assert_eq!(multiply_groups(&again), 1);

    // A second round trip is the same as the first.
    let idml2 = again.export_idml().expect("export again");
    let third = CanvasModel::load("third", &idml2, CanvasOptions::default()).expect("third");
    assert_eq!(serde_json::to_string(&layers(&third)).unwrap(), want);
    let t = idml_import::import_idml_doc(&idml2).expect("twin 2");
    assert_eq!(
        t.spreads[0].spread.rectangles.len(),
        2,
        "no baked item is left in the model"
    );
}

#[test]
#[allow(non_snake_case)]
fn the_raw_idml_holds_a_group_of_single_paint_items__feat__frames_paths_native_appearance() {
    let mut m = load();
    set(&mut m, three_paints()).unwrap();
    let idml = m.export_idml().expect("export idml");
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(&idml)).expect("zip");
    let mut spread = String::new();
    std::io::Read::read_to_string(
        &mut zip
            .by_name("Spreads/Spread_s1.xml")
            .expect("the spread part"),
        &mut spread,
    )
    .expect("utf-8");
    let group_at = spread.find("<Group ").expect("a <Group>");
    let r1_at = spread.find("Self=\"r1\"").expect("the carrier");
    assert!(group_at < r1_at, "the carrier sits inside the group");
    assert!(
        spread.contains("paged:appearanceLayer"),
        "the baked items are labelled"
    );
    assert!(
        spread.contains("BlendMode=\"Multiply\""),
        "the red layer's blend"
    );
    assert!(spread.contains("StrokeWeight=\"8\""), "the blue stroke");
}
