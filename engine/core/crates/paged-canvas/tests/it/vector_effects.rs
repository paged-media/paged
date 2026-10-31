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

//! Engine ADR 1042 — live vector effects through the canvas model: the
//! effect-stack paths take the vector kinds and a group takes
//! `groupEffectStack`; hit testing and point snapping see the effected
//! outline; a Pathfinder boolean reads it; `expandAppearance` keeps it
//! for good as one undo step that undoes to the exact state hash; an IDML
//! export bakes the outline, reports it, and re-imports live.

use std::io::Write;

use paged_canvas::{channel::Mutation, CanvasModel, CanvasOptions, PageId};
use paged_mutate::operation::{EffectEntrySpec, EffectKind};
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
</idPkg:Graphic>"#,
        );
        put(
            "Spreads/Spread_s1.xml",
            br#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Spread xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="13.1">
<Spread Self="s1" PageCount="1">
<Page Self="p1" Name="1" GeometricBounds="0 0 792 612" ItemTransform="1 0 0 1 0 0"/>
<Rectangle Self="r1" FillColor="Color/Black" StrokeWeight="0" ItemTransform="1 0 0 1 0 0"><Properties><PathGeometry><GeometryPathType PathOpen="false"><PathPointArray><PathPointType Anchor="50 50" LeftDirection="50 50" RightDirection="50 50"/><PathPointType Anchor="200 50" LeftDirection="200 50" RightDirection="200 50"/><PathPointType Anchor="200 200" LeftDirection="200 200" RightDirection="200 200"/><PathPointType Anchor="50 200" LeftDirection="50 200" RightDirection="50 200"/></PathPointArray></GeometryPathType></PathGeometry></Properties></Rectangle>
<Oval Self="o1" GeometricBounds="50 300 150 400" FillColor="Color/Red" StrokeWeight="0" ItemTransform="1 0 0 1 0 0"/>
<Group Self="g1" ItemTransform="1 0 0 1 0 0">
<Rectangle Self="a1" GeometricBounds="300 50 400 150" FillColor="Color/Black" StrokeWeight="0" ItemTransform="1 0 0 1 0 0"/>
<Rectangle Self="b1" GeometricBounds="350 100 450 200" FillColor="Color/Red" StrokeWeight="0" ItemTransform="1 0 0 1 0 0"/>
</Group>
</Spread></idPkg:Spread>"#,
        );
        zip.finish().unwrap();
    }
    buf
}

fn load() -> CanvasModel {
    CanvasModel::load("vector-effects", &idml(), CanvasOptions::default()).expect("load")
}

fn el(e: ElementId) -> VirtualTarget {
    VirtualTarget::Element { element_id: e }
}

fn r1() -> VirtualTarget {
    el(ElementId::Rectangle("r1".into()))
}

fn stack(m: &CanvasModel, t: &VirtualTarget, path: &str) -> Vec<EffectEntrySpec> {
    match m.get_property(t, path) {
        Ok(Value::EffectStack { entries, .. }) => entries,
        other => panic!("{path}: {other:?}"),
    }
}

fn set(
    m: &mut CanvasModel,
    t: &VirtualTarget,
    path: &str,
    entries: Vec<EffectEntrySpec>,
) -> Result<(), String> {
    m.apply_mutation(&Mutation::Set {
        address: t.clone().into(),
        path: path.to_string(),
        value: Value::EffectStack {
            entries,
            prev: None,
        },
    })
    .map(|_| ())
    .map_err(|e| format!("{e:?}"))
}

fn zig() -> EffectEntrySpec {
    EffectEntrySpec {
        size: Some(10.0),
        ridges: Some(4),
        ..EffectEntrySpec::new(EffectKind::ZigZag)
    }
}

fn page(m: &CanvasModel) -> PageId {
    PageId(m.pages()[0].self_id.clone())
}

#[test]
#[allow(non_snake_case)]
fn a_vector_effect_is_a_stack_entry_and_undoes_exactly__feat__effects_transparency_live_vector_effects(
) {
    let mut m = load();
    let h0 = m.current_state_hash();
    set(&mut m, &r1(), "frameEffectStack", vec![zig()]).unwrap();
    let read = stack(&m, &r1(), "frameEffectStack");
    assert_eq!(read.len(), 1);
    assert_eq!(read[0].kind, EffectKind::ZigZag);
    assert_eq!(read[0].ridges, Some(4));
    assert_eq!(read[0].size, Some(10.0));
    assert_ne!(m.current_state_hash(), h0);
    m.undo().expect("undo");
    assert_eq!(m.current_state_hash(), h0);
    // A Pathfinder entry belongs on a group.
    let err = set(
        &mut m,
        &r1(),
        "frameEffectStack",
        vec![EffectEntrySpec::new(EffectKind::Pathfinder)],
    )
    .unwrap_err();
    assert!(err.contains("group"), "{err}");
}

#[test]
fn hit_testing_and_snapping_see_the_effected_outline() {
    let mut m = load();
    // Above the rectangle: nothing there.
    assert!(m.hit_test(&page(&m), (110.0, 45.0)).element.is_none());
    set(&mut m, &r1(), "frameEffectStack", vec![zig()]).unwrap();
    // The second ridge of the top edge reaches up to y = 40.
    let hit = m.hit_test(&page(&m), (110.0, 45.0));
    assert_eq!(hit.element, Some(ElementId::Rectangle("r1".into())));
    // Selection still reports the source box.
    assert_eq!(hit.bounds, Some([50.0, 50.0, 200.0, 200.0]));
    let q = paged_canvas::snap_point::SnapPointQuery {
        page_id: page(&m),
        point: [111.0, 41.0],
        camera_scale: Some(1.0),
        exclude: Vec::new(),
        extra_points: Vec::new(),
    };
    let r = m.snap_point(&q);
    assert!(r.snapped);
    assert!(
        (r.point[0] - 110.0).abs() < 0.01 && (r.point[1] - 40.0).abs() < 0.01,
        "snapped to the ridge point: {:?}",
        r.point
    );
    let hit = r.point_target.expect("a point");
    assert_eq!(hit.anchor_index, None, "an effected point names no anchor");
}

#[test]
fn a_group_takes_a_pathfinder_effect() {
    let mut m = load();
    let g = el(ElementId::Group("g1".into()));
    assert!(stack(&m, &g, "groupEffectStack").is_empty());
    let h0 = m.current_state_hash();
    let pf = EffectEntrySpec {
        op: Some("subtract".into()),
        ..EffectEntrySpec::new(EffectKind::Pathfinder)
    };
    set(&mut m, &g, "groupEffectStack", vec![pf]).unwrap();
    let read = stack(&m, &g, "groupEffectStack");
    assert_eq!(read[0].op.as_deref(), Some("subtract"));
    // A paint effect is refused on a group's stack.
    let err = set(
        &mut m,
        &g,
        "groupEffectStack",
        vec![EffectEntrySpec::new(EffectKind::GaussianBlur)],
    )
    .unwrap_err();
    assert!(err.contains("vector"), "{err}");
    m.undo().expect("undo");
    assert_eq!(m.current_state_hash(), h0);
}

#[test]
fn a_boolean_reads_the_effected_outline() {
    let mut m = load();
    let off = EffectEntrySpec {
        offset: Some(20.0),
        ..EffectEntrySpec::new(EffectKind::OffsetPath)
    };
    set(
        &mut m,
        &el(ElementId::Rectangle("a1".into())),
        "frameEffectStack",
        vec![off],
    )
    .unwrap();
    m.apply_mutation(&Mutation::PathfinderBoolean {
        kept: ElementId::Rectangle("a1".into()),
        others: vec![ElementId::Rectangle("b1".into())],
        kind: paged_mutate::PathfinderKind::Union,
    })
    .expect("unite");
    let a1 = m.scene().spreads[0]
        .spread
        .rectangles
        .iter()
        .find(|r| r.self_id.as_deref() == Some("a1"))
        .expect("a1 is kept");
    // The kept item's path is the union of the grown a1 and b1: it reaches
    // 20 pt left of a1's source edge, and its effects are spent.
    let min_x = a1
        .anchors
        .iter()
        .map(|a| a.anchor.0)
        .fold(f32::INFINITY, f32::min);
    assert!((min_x - 30.0).abs() < 0.5, "{min_x}");
    assert!(a1.effect_stack.is_empty());
}

#[test]
#[allow(non_snake_case)]
fn expand_appearance_keeps_the_outline_in_one_undo_step__feat__effects_transparency_live_vector_effects(
) {
    let mut m = load();
    let h0 = m.current_state_hash();
    // A rectangle: in place.
    set(&mut m, &r1(), "frameEffectStack", vec![zig()]).unwrap();
    let h1 = m.current_state_hash();
    m.apply_mutation(&Mutation::ExpandAppearance {
        element_id: ElementId::Rectangle("r1".into()),
    })
    .expect("expand");
    {
        let r = &m.scene().spreads[0].spread.rectangles[0];
        assert_eq!(r.anchors.len(), 20);
        assert!(r.effect_stack.is_empty());
    }
    m.undo().expect("undo expand");
    assert_eq!(m.current_state_hash(), h1);
    m.redo().expect("redo expand");
    m.undo().expect("undo again");
    m.undo().expect("undo zig");
    assert_eq!(m.current_state_hash(), h0);
    // Nothing to expand is refused.
    assert!(m
        .apply_mutation(&Mutation::ExpandAppearance {
            element_id: ElementId::Rectangle("r1".into()),
        })
        .is_err());

    // An oval becomes a polygon of its id.
    let bloat = EffectEntrySpec {
        amount_pct: Some(40.0),
        ..EffectEntrySpec::new(EffectKind::PuckerBloat)
    };
    let o1 = el(ElementId::Oval("o1".into()));
    set(&mut m, &o1, "frameEffectStack", vec![bloat]).unwrap();
    let h2 = m.current_state_hash();
    m.apply_mutation(&Mutation::ExpandAppearance {
        element_id: ElementId::Oval("o1".into()),
    })
    .expect("expand oval");
    {
        let s = &m.scene().spreads[0].spread;
        assert!(s.ovals.is_empty());
        assert!(s
            .polygons
            .iter()
            .any(|p| p.self_id.as_deref() == Some("o1")));
    }
    m.undo().expect("undo oval");
    assert_eq!(m.current_state_hash(), h2);

    // A group with a Pathfinder effect becomes one polygon of its id.
    let g = el(ElementId::Group("g1".into()));
    set(
        &mut m,
        &g,
        "groupEffectStack",
        vec![EffectEntrySpec::new(EffectKind::Pathfinder)],
    )
    .unwrap();
    let h3 = m.current_state_hash();
    m.apply_mutation(&Mutation::ExpandAppearance {
        element_id: ElementId::Group("g1".into()),
    })
    .expect("expand group");
    {
        let s = &m.scene().spreads[0].spread;
        assert!(s.groups.is_empty());
        let p = s
            .polygons
            .iter()
            .find(|p| p.self_id.as_deref() == Some("g1"))
            .expect("the united outline");
        assert_eq!(
            p.fill_color.as_deref(),
            Some("Color/Red"),
            "the front member's paint"
        );
        assert!(s
            .rectangles
            .iter()
            .all(|r| r.self_id.as_deref() == Some("r1")));
    }
    m.undo().expect("undo group");
    assert_eq!(m.current_state_hash(), h3);
}

#[test]
#[allow(non_snake_case)]
fn idml_bakes_reports_and_reimports_live__feat__effects_transparency_live_vector_effects() {
    let mut m = load();
    let clean = m.idml_export_losses();
    set(&mut m, &r1(), "frameEffectStack", vec![zig()]).unwrap();
    let bloat = EffectEntrySpec {
        amount_pct: Some(40.0),
        ..EffectEntrySpec::new(EffectKind::PuckerBloat)
    };
    set(
        &mut m,
        &el(ElementId::Oval("o1".into())),
        "frameEffectStack",
        vec![bloat],
    )
    .unwrap();
    set(
        &mut m,
        &el(ElementId::Group("g1".into())),
        "groupEffectStack",
        vec![EffectEntrySpec::new(EffectKind::Pathfinder)],
    )
    .unwrap();
    let losses: Vec<String> = m
        .idml_export_losses()
        .into_iter()
        .filter(|l| !clean.contains(l))
        .collect();
    assert_eq!(losses.len(), 3, "{losses:?}");
    assert!(losses
        .iter()
        .any(|l| l.contains("`zigZag`") && l.contains("`r1`")));
    assert!(losses
        .iter()
        .any(|l| l.contains("`o1`") && l.contains("polygon")));
    assert!(losses
        .iter()
        .any(|l| l.contains("`g1`") && l.contains("group")));

    let idml = m.export_idml().expect("export idml");
    // What InDesign reads: the baked outlines.
    let raw = paged_canvas_test_idml_spread(&idml);
    assert!(
        raw.contains("paged:vectorSource"),
        "the source rides a label"
    );
    assert!(!raw.contains("<Oval "), "the oval is written as a polygon");
    assert!(
        raw.contains("Self=\"g1vfx\"") && !raw.contains("Self=\"a1\""),
        "the group's members are written as one polygon"
    );

    // A paged reader gets the live effects back.
    let again = CanvasModel::load("again", &idml, CanvasOptions::default()).expect("re-import");
    let s = &again.scene().spreads[0].spread;
    let r = s
        .rectangles
        .iter()
        .find(|r| r.self_id.as_deref() == Some("r1"))
        .unwrap();
    assert_eq!(r.effect_stack.len(), 1, "the zig zag is live again");
    assert_eq!(
        r.anchors.len(),
        m.scene().spreads[0].spread.rectangles[0].anchors.len()
    );
    let o = s
        .ovals
        .iter()
        .find(|o| o.self_id.as_deref() == Some("o1"))
        .expect("the oval");
    assert_eq!(o.effect_stack.len(), 1);
    let g = s
        .groups
        .iter()
        .find(|g| g.self_id.as_deref() == Some("g1"))
        .expect("the group");
    assert_eq!(g.members.len(), 2);
    assert_eq!(g.effect_stack.len(), 1);
    assert!(s.polygons.is_empty(), "no baked stand-in is left");
}

fn paged_canvas_test_idml_spread(idml: &[u8]) -> String {
    use std::io::Read;
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(idml)).unwrap();
    let mut out = String::new();
    zip.by_name("Spreads/Spread_s1.xml")
        .unwrap()
        .read_to_string(&mut out)
        .unwrap();
    out
}

#[test]
fn the_effects_survive_a_paged_round_trip() {
    let mut m = load();
    set(&mut m, &r1(), "frameEffectStack", vec![zig()]).unwrap();
    set(
        &mut m,
        &el(ElementId::Group("g1".into())),
        "groupEffectStack",
        vec![EffectEntrySpec::new(EffectKind::Pathfinder)],
    )
    .unwrap();
    m.refresh_model_part().expect("refresh model part");
    let bytes = m
        .export_paged(paged_canvas::channel::PROTOCOL_VERSION.0)
        .expect("export .paged");
    let back = CanvasModel::load("back", &bytes, CanvasOptions::default()).expect("reload");
    assert_eq!(
        stack(&back, &r1(), "frameEffectStack")[0].kind,
        EffectKind::ZigZag
    );
    assert_eq!(
        stack(
            &back,
            &el(ElementId::Group("g1".into())),
            "groupEffectStack"
        )[0]
        .kind,
        EffectKind::Pathfinder
    );
}

/// Draw ADR 367 — an envelope (a Bézier patch mesh) is a stack entry like
/// the others: written with its net, read back whole, expanded in one undo
/// step, and kept live through an IDML this engine wrote.
#[test]
fn an_envelope_mesh_is_a_vector_entry__feat__effects_transparency_live_vector_effects() {
    let mut m = load();
    let h0 = m.current_state_hash();
    let mut net = paged_model::vector_effect::EnvelopeParams::flat(1, 2);
    // Pull the top edge's middle node (row 0, column 3 of 7) up by a
    // third of the height.
    net[3] = [0.5, -0.3333];
    let env = EffectEntrySpec {
        rows: Some(1),
        columns: Some(2),
        mesh: Some(net.clone()),
        ..EffectEntrySpec::new(EffectKind::Envelope)
    };
    set(&mut m, &r1(), "frameEffectStack", vec![env]).unwrap();
    let back = stack(&m, &r1(), "frameEffectStack");
    assert_eq!(back.len(), 1);
    assert_eq!(back[0].kind, EffectKind::Envelope);
    assert_eq!(back[0].mesh.as_deref(), Some(&net[..]));
    // A wrong net size is refused by name.
    let bad = EffectEntrySpec {
        rows: Some(3),
        mesh: Some(net.clone()),
        ..EffectEntrySpec::new(EffectKind::Envelope)
    };
    assert!(set(&mut m, &r1(), "frameEffectStack", vec![bad])
        .unwrap_err()
        .contains("mesh"));

    // IDML: baked, the source in a label, live again on re-import.
    let idml = m.export_idml().expect("export idml");
    let again = CanvasModel::load("again", &idml, CanvasOptions::default()).expect("re-import");
    let r = again.scene().spreads[0]
        .spread
        .rectangles
        .iter()
        .find(|r| r.self_id.as_deref() == Some("r1"))
        .unwrap()
        .clone();
    assert_eq!(r.effect_stack.len(), 1, "the envelope is live again");

    // Expand keeps the bent outline: more anchors than the four corners,
    // the top reaching above the box.
    let top0 = m.scene().spreads[0].spread.rectangles[0]
        .anchors
        .iter()
        .map(|a| a.anchor.1)
        .fold(f32::INFINITY, f32::min);
    let h1 = m.current_state_hash();
    m.apply_mutation(&Mutation::ExpandAppearance {
        element_id: ElementId::Rectangle("r1".into()),
    })
    .expect("expand");
    {
        let r = &m.scene().spreads[0].spread.rectangles[0];
        assert!(r.anchors.len() > 4, "{}", r.anchors.len());
        assert!(r.effect_stack.is_empty());
        let top = r
            .anchors
            .iter()
            .map(|a| a.anchor.1)
            .fold(f32::INFINITY, f32::min);
        assert!(top < top0 - 1.0, "{top} vs {top0}");
    }
    m.undo().expect("undo expand");
    assert_eq!(m.current_state_hash(), h1);
    m.undo().expect("undo envelope");
    assert_eq!(m.current_state_hash(), h0);
}
