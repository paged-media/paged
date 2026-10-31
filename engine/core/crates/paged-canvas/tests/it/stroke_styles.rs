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

//! Engine ADR 10XX — stroke styles (width profiles, brushes) through the
//! canvas model: the stack paths take them on a page item and refuse them
//! on a group; Expand Appearance keeps a stroke-only item's artwork and
//! refuses an item whose fill the artwork would drop; an IDML export
//! writes a filled item as its fill and a polygon of its stroke artwork,
//! reports it, and a paged reader gets the live stroke style back.

use std::io::Write;

use paged_canvas::{channel::Mutation, CanvasModel, CanvasOptions};
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
<Rectangle Self="r1" FillColor="Color/Black" StrokeColor="Color/Red" StrokeWeight="6" ItemTransform="1 0 0 1 0 0"><Properties><PathGeometry><GeometryPathType PathOpen="false"><PathPointArray><PathPointType Anchor="50 50" LeftDirection="50 50" RightDirection="50 50"/><PathPointType Anchor="200 50" LeftDirection="200 50" RightDirection="200 50"/><PathPointType Anchor="200 200" LeftDirection="200 200" RightDirection="200 200"/><PathPointType Anchor="50 200" LeftDirection="50 200" RightDirection="50 200"/></PathPointArray></GeometryPathType></PathGeometry></Properties></Rectangle>
<Polygon Self="l1" FillColor="Swatch/None" StrokeColor="Color/Red" StrokeWeight="8" ItemTransform="1 0 0 1 0 0"><Properties><PathGeometry><GeometryPathType PathOpen="true"><PathPointArray><PathPointType Anchor="50 300" LeftDirection="50 300" RightDirection="50 300"/><PathPointType Anchor="250 350" LeftDirection="250 350" RightDirection="250 350"/></PathPointArray></GeometryPathType></PathGeometry></Properties></Polygon>
<Group Self="g1" ItemTransform="1 0 0 1 0 0">
<Rectangle Self="a1" GeometricBounds="400 50 500 150" FillColor="Color/Black" StrokeWeight="0" ItemTransform="1 0 0 1 0 0"/>
</Group>
</Spread></idPkg:Spread>"#,
        );
        zip.finish().unwrap();
    }
    buf
}

fn load() -> CanvasModel {
    CanvasModel::load("stroke-styles", &idml(), CanvasOptions::default()).expect("load")
}

fn el(e: ElementId) -> VirtualTarget {
    VirtualTarget::Element { element_id: e }
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

fn profile() -> EffectEntrySpec {
    EffectEntrySpec {
        width_points: Some(vec![[0.0, 0.2], [0.5, 2.0], [1.0, 0.2]]),
        ..EffectEntrySpec::new(EffectKind::WidthProfile)
    }
}

fn scatter() -> EffectEntrySpec {
    EffectEntrySpec {
        brush_type: Some("scatter".into()),
        spacing_pct: Some(150.0),
        seed: Some(9),
        ..EffectEntrySpec::new(EffectKind::Brush)
    }
}

fn read(m: &CanvasModel, t: &VirtualTarget) -> Vec<EffectEntrySpec> {
    match m.get_property(t, "frameEffectStack") {
        Ok(Value::EffectStack { entries, .. }) => entries,
        other => panic!("{other:?}"),
    }
}

#[test]
#[allow(non_snake_case)]
fn a_stroke_style_is_a_stack_entry_and_undoes_exactly__feat__plugin_draw_brushes_width() {
    let mut m = load();
    let l1 = el(ElementId::Polygon("l1".into()));
    let h0 = m.current_state_hash();
    set(&mut m, &l1, "frameEffectStack", vec![profile(), scatter()]).unwrap();
    let back = read(&m, &l1);
    assert_eq!(back.len(), 2);
    assert_eq!(back[0].kind, EffectKind::WidthProfile);
    assert_eq!(
        back[0].width_points.as_deref(),
        Some(&[[0.0, 0.2], [0.5, 2.0], [1.0, 0.2]][..])
    );
    assert_eq!(back[1].brush_type.as_deref(), Some("scatter"));
    assert_eq!(back[1].seed, Some(9));
    m.undo().expect("undo");
    assert_eq!(m.current_state_hash(), h0);
    // Bad values are refused with their reason.
    let bad = EffectEntrySpec {
        brush_type: Some("calligraphic".into()),
        ..EffectEntrySpec::new(EffectKind::Brush)
    };
    assert!(set(&mut m, &l1, "frameEffectStack", vec![bad])
        .unwrap_err()
        .contains("brushType"));
    // A group has no stroke to style.
    let err = set(
        &mut m,
        &el(ElementId::Group("g1".into())),
        "groupEffectStack",
        vec![EffectEntrySpec::new(EffectKind::Brush)],
    )
    .unwrap_err();
    assert!(err.contains("a group has none"), "{err}");
}

#[test]
#[allow(non_snake_case)]
fn expand_appearance_keeps_a_stroke_only_items_artwork__feat__plugin_draw_brushes_width() {
    let mut m = load();
    let l1 = el(ElementId::Polygon("l1".into()));
    set(&mut m, &l1, "frameEffectStack", vec![profile()]).unwrap();
    let h1 = m.current_state_hash();
    m.apply_mutation(&Mutation::ExpandAppearance {
        element_id: ElementId::Polygon("l1".into()),
    })
    .expect("expand");
    {
        let p = m.scene().spreads[0]
            .spread
            .polygons
            .iter()
            .find(|p| p.self_id.as_deref() == Some("l1"))
            .unwrap();
        assert_eq!(p.fill_color.as_deref(), Some("Color/Red"));
        assert!(p.effect_stack.is_empty());
        assert!(p.anchors.len() > 10, "the swelling band");
    }
    m.undo().expect("undo");
    assert_eq!(m.current_state_hash(), h1);
    // A filled item's artwork would drop its fill: refused.
    let r1 = el(ElementId::Rectangle("r1".into()));
    set(&mut m, &r1, "frameEffectStack", vec![profile()]).unwrap();
    let err = m
        .apply_mutation(&Mutation::ExpandAppearance {
            element_id: ElementId::Rectangle("r1".into()),
        })
        .unwrap_err();
    assert!(format!("{err:?}").contains("stroke style"), "{err:?}");
}

fn spread_xml(idml: &[u8]) -> String {
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
#[allow(non_snake_case)]
fn idml_writes_the_fill_and_the_artwork_and_reimports_live__feat__plugin_draw_brushes_width() {
    let mut m = load();
    let clean = m.idml_export_losses();
    set(
        &mut m,
        &el(ElementId::Rectangle("r1".into())),
        "frameEffectStack",
        vec![profile()],
    )
    .unwrap();
    set(
        &mut m,
        &el(ElementId::Polygon("l1".into())),
        "frameEffectStack",
        vec![scatter()],
    )
    .unwrap();
    let losses: Vec<String> = m
        .idml_export_losses()
        .into_iter()
        .filter(|l| !clean.contains(l))
        .collect();
    assert_eq!(losses.len(), 2, "{losses:?}");
    assert!(losses
        .iter()
        .any(|l| l.contains("`widthProfile`") && l.contains("`r1`") && l.contains("<id>vfx")));
    assert!(losses
        .iter()
        .any(|l| l.contains("`brush`") && l.contains("`l1`") && !l.contains("<id>vfx")));

    {
        let l = m.scene().spreads[0]
            .spread
            .polygons
            .iter()
            .find(|p| p.self_id.as_deref() == Some("l1"))
            .unwrap();
        let b = paged_vector_fx::bake::bake_polygon(l).unwrap();
        eprintln!(
            "SRC {:?} {:?} {:?} BAKED {} {:?} {:?}",
            l.anchors,
            l.subpath_starts,
            l.subpath_open,
            b.anchors.len(),
            b.subpath_starts,
            b.subpath_open
        );
    }
    let idml = m.export_idml().expect("export");
    let raw = spread_xml(&idml);
    assert!(raw.contains("Self=\"r1vfx\""), "the stroke artwork of r1");
    assert!(raw.contains("paged:strokeArtOf"));
    // The artwork follows the rectangle it was split off.
    let at_r1 = raw.find("Self=\"r1\"").unwrap();
    let at_art = raw.find("Self=\"r1vfx\"").unwrap();
    assert!(at_art > at_r1);

    // InDesign's view: a paged reader that ignored the labels would see
    // the rectangle without its stroke and the artwork filled red.
    let again = CanvasModel::load("again", &idml, CanvasOptions::default()).expect("re-import");
    let s = &again.scene().spreads[0].spread;
    let r = s
        .rectangles
        .iter()
        .find(|r| r.self_id.as_deref() == Some("r1"))
        .unwrap();
    assert_eq!(r.effect_stack.len(), 1, "the width profile is live again");
    assert_eq!(r.stroke_color.as_deref(), Some("Color/Red"));
    assert_eq!(r.fill_color.as_deref(), Some("Color/Black"));
    let l = s
        .polygons
        .iter()
        .find(|p| p.self_id.as_deref() == Some("l1"))
        .unwrap();
    eprintln!("RAWL1 {}", &raw[raw.find("Self=\"l1\"").unwrap()..]);
    eprintln!(
        "L1 {} {:?} {:?} {:?}",
        l.anchors.len(),
        l.subpath_starts,
        l.fill_color,
        s.labels.get("l1").map(|v| v
            .iter()
            .map(|(k, x)| (k.clone(), x.len()))
            .collect::<Vec<_>>())
    );
    assert_eq!(l.effect_stack.len(), 1, "the brush is live again");
    assert_eq!(l.fill_color.as_deref(), Some("Swatch/None"));
    assert!(
        !s.polygons
            .iter()
            .any(|p| p.self_id.as_deref() == Some("r1vfx")),
        "the artwork stand-in is gone"
    );
}
