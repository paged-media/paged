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

//! Engine ADR 1041 — pattern swatches through the canvas: created,
//! applied, listed and undone in one step each; kept by `.paged`; and on
//! IDML export carried in the frame's label, restored by the import, with
//! the loss lines.
#![allow(non_snake_case)]

use std::io::Write;

use paged_canvas::{channel::Mutation, element_selection::ElementId, CanvasModel, CanvasOptions};
use paged_mutate::operation::PathAnchorSpec;
use paged_mutate::{
    PatternColorSpec, PatternItemSpec, PatternSpec, PropertyPath, SwatchSpec, Value,
};

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
    <Rectangle Self="r1" GeometricBounds="50 100 250 300" FillColor="Color/Sun" StrokeColor="Color/Sky" StrokeWeight="4"/>
  </Spread>
</idPkg:Spread>"#,
    )
    .unwrap();
    zip.finish().unwrap().into_inner()
}

fn load() -> CanvasModel {
    CanvasModel::load("pattern", &idml(), CanvasOptions::default()).expect("load")
}

fn rect() -> ElementId {
    ElementId::Rectangle("r1".into())
}

fn pattern() -> PatternSpec {
    let a = |x: f32, y: f32| PathAnchorSpec {
        anchor: [x, y],
        left: [x, y],
        right: [x, y],
    };
    PatternSpec {
        width: 20.0,
        height: 20.0,
        items: vec![PatternItemSpec {
            anchors: vec![a(0.0, 0.0), a(10.0, 0.0), a(10.0, 10.0), a(0.0, 10.0)],
            subpath_starts: vec![],
            subpath_open: vec![],
            fill_rule: None,
            fill: Some(PatternColorSpec {
                swatch: Some("Color/Sky".into()),
                space: None,
                value: vec![],
            }),
            stroke: None,
            stroke_weight: None,
        }],
        tile_type: Some("BrickByColumn".into()),
        brick_offset: None,
        h_spacing: None,
        v_spacing: None,
        h_overlap: None,
        v_overlap: None,
        offset: None,
        scale: None,
        rotation_deg: Some(30.0),
    }
}

fn create(m: &mut CanvasModel) -> String {
    m.apply_mutation(&Mutation::CreateSwatch {
        spec: SwatchSpec {
            self_id: Some("Pattern/dots".into()),
            name: Some("Dots".into()),
            space: String::new(),
            value: vec![],
            model: None,
            alternate_space: None,
            alternate_value: vec![],
            tint: None,
            alpha: None,
            pattern: Some(pattern()),
        },
    })
    .expect("create a pattern swatch");
    "Pattern/dots".into()
}

fn set(m: &mut CanvasModel, path: PropertyPath, value: Value) {
    m.apply_mutation(&Mutation::SetElementProperty {
        element_id: rect(),
        path,
        value,
    })
    .unwrap_or_else(|e| panic!("{path:?}: {e:?}"));
}

fn read(m: &CanvasModel, path: PropertyPath) -> Option<Value> {
    m.element_properties(&rect())
        .expect("element answers properties")
        .entries
        .into_iter()
        .find(|e| e.path == path)
        .and_then(|e| e.value)
}

fn digests(m: &CanvasModel) -> Vec<u64> {
    m.built().pages.iter().map(|p| p.list.digest()).collect()
}

const T: [f32; 6] = [1.0, 0.0, 0.0, 1.0, 4.0, 0.0];

#[test]
fn a_pattern_swatch_is_listed_applied_and_undone_in_steps__feat__color_swatches_pattern_paint() {
    let mut m = load();
    let before = digests(&m);
    let id = create(&mut m);
    let listed = m.swatches();
    let row = listed.iter().find(|s| s.self_id == id).expect("listed");
    assert_eq!(row.kind, "pattern");
    assert_eq!(row.name, "Dots");
    assert_eq!(
        m.pattern_detail(&id),
        Some({
            let mut p = pattern();
            // The detail is the full spec, defaults written out.
            p.tile_type = Some("BrickByColumn".into());
            PatternSpec::from_model(&p.to_model(id.clone(), None).unwrap())
        })
    );
    set(
        &mut m,
        PropertyPath::FrameFillColor,
        Value::ColorRef(Some(id.clone())),
    );
    set(
        &mut m,
        PropertyPath::FrameStrokeColor,
        Value::ColorRef(Some(id.clone())),
    );
    set(
        &mut m,
        PropertyPath::FramePatternTransform,
        Value::Transform(Some(T)),
    );
    assert_eq!(
        read(&m, PropertyPath::FramePatternTransform),
        Some(Value::Transform(Some(T)))
    );
    let painted = digests(&m);
    assert_ne!(painted, before, "the pattern draws");
    let list = &m.built().pages[0].list;
    assert_eq!(list.patterns.len(), 2, "a fill use and a stroke use");
    m.undo().expect("undo transform");
    assert_eq!(
        read(&m, PropertyPath::FramePatternTransform),
        Some(Value::Transform(None))
    );
    m.undo().expect("undo stroke");
    m.undo().expect("undo fill");
    assert_eq!(
        read(&m, PropertyPath::FrameFillColor),
        Some(Value::ColorRef(Some("Color/Sun".into())))
    );
    m.undo().expect("undo create");
    assert!(!m.swatches().iter().any(|s| s.kind == "pattern"));
    assert_eq!(digests(&m), before, "undo restores the drawing");
}

#[test]
fn a_pattern_survives_paged__feat__color_swatches_pattern_paint() {
    let mut m = load();
    let id = create(&mut m);
    set(
        &mut m,
        PropertyPath::FrameFillColor,
        Value::ColorRef(Some(id.clone())),
    );
    set(
        &mut m,
        PropertyPath::FramePatternTransform,
        Value::Transform(Some(T)),
    );
    let painted = digests(&m);
    m.refresh_model_part().expect("refresh model part");
    let bytes = m
        .export_paged(paged_canvas::channel::PROTOCOL_VERSION.0)
        .expect("export .paged");
    let back = CanvasModel::load("pattern-back", &bytes, CanvasOptions::default()).expect("reload");
    assert_eq!(back.pattern_detail(&id), m.pattern_detail(&id));
    assert_eq!(
        read(&back, PropertyPath::FrameFillColor),
        Some(Value::ColorRef(Some(id)))
    );
    assert_eq!(
        read(&back, PropertyPath::FramePatternTransform),
        Some(Value::Transform(Some(T)))
    );
    assert_eq!(digests(&back), painted);
}

#[test]
fn the_idml_export_keeps_the_pattern_in_a_label_and_names_the_loss__feat__color_swatches_pattern_paint(
) {
    let mut m = load();
    let clean = m.idml_export_losses();
    let id = create(&mut m);
    let new_losses = |m: &CanvasModel| -> Vec<String> {
        m.idml_export_losses()
            .into_iter()
            .filter(|l| !clean.contains(l))
            .collect()
    };
    // Unused: one line, the swatch is not written.
    let unused = new_losses(&m);
    assert_eq!(unused.len(), 1, "{unused:?}");
    assert!(unused[0].contains("used by no frame"), "{unused:?}");
    set(
        &mut m,
        PropertyPath::FrameFillColor,
        Value::ColorRef(Some(id.clone())),
    );
    set(
        &mut m,
        PropertyPath::FrameStrokeColor,
        Value::ColorRef(Some(id.clone())),
    );
    set(
        &mut m,
        PropertyPath::FramePatternTransform,
        Value::Transform(Some(T)),
    );
    let losses = new_losses(&m);
    assert_eq!(losses.len(), 2, "{losses:?}");
    assert!(
        losses.iter().any(|l| l.contains("fill of rectangle `r1`")
            && l.contains("label")
            && l.contains("restores")),
        "{losses:?}"
    );
    assert!(losses
        .iter()
        .any(|l| l.contains("stroke of rectangle `r1`")));
    let painted = digests(&m);
    let bytes = m.export_idml().expect("export idml");
    // InDesign sees the stand-in: the first item's document colour.
    let archive = idml_import::open_source_archive(&bytes).expect("archive");
    let spread_xml = String::from_utf8_lossy(
        archive
            .entry("Spreads/Spread_sp1.xml")
            .expect("spread part"),
    )
    .into_owned();
    assert!(spread_xml.contains("paged:fillPattern"), "{spread_xml}");
    assert!(spread_xml.contains("paged:strokePattern"));
    assert!(
        spread_xml.contains("FillColor=\"Color/Sky\""),
        "{spread_xml}"
    );
    let graphic = String::from_utf8_lossy(
        archive
            .entry("Resources/Graphic.xml")
            .expect("graphic part"),
    )
    .into_owned();
    assert!(!graphic.contains("Pattern/"), "IDML has no pattern swatch");
    // A paged import restores the swatch, the paints and the transform.
    let back = CanvasModel::load("pattern-idml", &bytes, CanvasOptions::default()).expect("reload");
    assert_eq!(back.pattern_detail(&id), m.pattern_detail(&id));
    assert_eq!(
        read(&back, PropertyPath::FrameFillColor),
        Some(Value::ColorRef(Some(id.clone())))
    );
    assert_eq!(
        read(&back, PropertyPath::FrameStrokeColor),
        Some(Value::ColorRef(Some(id)))
    );
    assert_eq!(
        read(&back, PropertyPath::FramePatternTransform),
        Some(Value::Transform(Some(T)))
    );
    assert_eq!(
        digests(&back),
        painted,
        "the round trip draws the same page"
    );
    let doc = idml_import::import_idml_doc(&bytes).expect("import");
    assert!(
        !doc.spreads[0].spread.labels.contains_key("r1"),
        "the label entries are consumed"
    );
}

#[test]
fn the_svg_export_writes_a_pattern_fill_as_an_svg_pattern__feat__color_swatches_pattern_paint() {
    let mut m = load();
    let id = create(&mut m);
    set(
        &mut m,
        PropertyPath::FrameFillColor,
        Value::ColorRef(Some(id.clone())),
    );
    let page = paged_canvas::PageId(m.pages()[0].self_id.clone());
    let (out, _report) = m
        .export_svg(&page, &[], &paged_svg::SvgExportOptions::default())
        .expect("export");
    // The tile is a `<pattern>` in the page's space, the frame's fill
    // names it, and the tile's items are drawn inside it.
    let at = out.find("<pattern id=\"").expect("a <pattern> def");
    let def = &out[at..at + out[at..].find("</pattern>").expect("closed")];
    assert!(def.contains("patternUnits=\"userSpaceOnUse\""), "{def}");
    assert!(def.contains("patternTransform=\"matrix("), "{def}");
    assert!(def.contains("<path d=\"M"), "the tile's items: {def}");
    let pid = &def["<pattern id=\"".len()..];
    let pid = &pid[..pid.find('"').unwrap()];
    assert!(
        out.contains(&format!("fill=\"url(#{pid})\"")),
        "the frame fills with it: {out}"
    );
}
