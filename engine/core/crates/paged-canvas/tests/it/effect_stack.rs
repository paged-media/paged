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

//! Engine ADR 1008 — `frameEffectStack` through the canvas model: it
//! reads the canonical stack of an imported item, writes add / reorder /
//! disable as one undo step each and undoes to the exact state hash,
//! reaches a disabled effect's parameters through its per-field paths,
//! applies to a text frame's text, survives `.paged` and an IDML round
//! trip (through the item's label), and reports what IDML cannot draw.

use std::io::Write;

use paged_canvas::{channel::Mutation, CanvasModel, CanvasOptions, PageId};
use paged_compose::{DisplayCommand, LayerEffect};
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
<idPkg:Story src="Stories/Story_story1.xml" xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"/>
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
<TextFrame Self="tf1" ParentStory="story1" GeometricBounds="300 100 500 400" ItemTransform="1 0 0 1 0 0"/>
<Rectangle Self="r1" GeometricBounds="50 50 200 200" FillColor="Color/Black" StrokeWeight="0" ItemTransform="1 0 0 1 0 0"><Properties/><TransparencySetting><DropShadowSetting Mode="Drop" XOffset="7" YOffset="7" Size="5" Opacity="75"/></TransparencySetting></Rectangle>
</Spread></idPkg:Spread>"#,
        );
        put(
            "Stories/Story_story1.xml",
            br#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Story xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="13.1">
<Story Self="story1">
<ParagraphStyleRange>
<CharacterStyleRange><Content>Hello world</Content></CharacterStyleRange>
</ParagraphStyleRange>
</Story></idPkg:Story>"#,
        );
        zip.finish().unwrap();
    }
    buf
}

fn load() -> CanvasModel {
    let font =
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../corpus/fonts/Inter.ttf");
    let opts = CanvasOptions {
        fonts: vec![std::fs::read(&font).expect("Inter.ttf")],
        ..CanvasOptions::default()
    };
    CanvasModel::load("effect-stack", &idml(), opts).expect("load")
}

fn rect() -> VirtualTarget {
    VirtualTarget::Element {
        element_id: ElementId::Rectangle("r1".into()),
    }
}

fn frame() -> VirtualTarget {
    VirtualTarget::Element {
        element_id: ElementId::TextFrame("tf1".into()),
    }
}

fn stack(m: &CanvasModel, t: &VirtualTarget, path: &str) -> Vec<EffectEntrySpec> {
    match m.get_property(t, path) {
        Ok(Value::EffectStack { entries, .. }) => entries,
        other => panic!("{path}: {other:?}"),
    }
}

fn kinds(entries: &[EffectEntrySpec]) -> Vec<EffectKind> {
    entries.iter().map(|e| e.kind).collect()
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

fn blur(r: f32) -> EffectEntrySpec {
    EffectEntrySpec {
        radius_pt: Some(r),
        ..EffectEntrySpec::new(EffectKind::GaussianBlur)
    }
}

fn outline_stroke() -> EffectEntrySpec {
    EffectEntrySpec {
        size_pt: Some(4.0),
        color: Some("Color/Red".into()),
        ..EffectEntrySpec::new(EffectKind::OutlineStroke)
    }
}

fn page_list(m: &CanvasModel) -> &paged_compose::DisplayList {
    let page = PageId(m.pages()[0].self_id.clone());
    m.display_list_for_page(&page).expect("display list")
}

fn has_blur(m: &CanvasModel) -> bool {
    page_list(m).commands.iter().any(|c| {
        matches!(
            c,
            DisplayCommand::PushLayer {
                effect: LayerEffect::GaussianBlur { .. },
                ..
            }
        )
    })
}

#[test]
#[allow(non_snake_case)]
fn an_imported_item_reads_its_canonical_stack__feat__effects_transparency_effect_stack() {
    let m = load();
    let s = stack(&m, &rect(), "frameEffectStack");
    assert_eq!(kinds(&s), [EffectKind::DropShadow]);
    assert!(s[0].enabled);
    assert!(stack(&m, &rect(), "frameFillEffectStack").is_empty());
    assert!(stack(&m, &frame(), "frameEffectStack").is_empty());
}

#[test]
#[allow(non_snake_case)]
fn add_reorder_and_undo_restore_the_state_exactly__feat__effects_transparency_effect_stack() {
    let mut m = load();
    let h0 = m.current_state_hash();
    // Writing the canonical stack back changes nothing.
    let canonical = stack(&m, &rect(), "frameEffectStack");
    set(&mut m, &rect(), "frameEffectStack", canonical.clone()).unwrap();
    assert_eq!(m.current_state_hash(), h0);

    // Add a blur and an outline stroke after the shadow.
    let mut s = canonical.clone();
    s.push(blur(3.0));
    s.push(outline_stroke());
    set(&mut m, &rect(), "frameEffectStack", s).unwrap();
    let h1 = m.current_state_hash();
    assert_ne!(h1, h0);
    let read = stack(&m, &rect(), "frameEffectStack");
    assert_eq!(
        kinds(&read),
        [
            EffectKind::DropShadow,
            EffectKind::GaussianBlur,
            EffectKind::OutlineStroke
        ]
    );
    assert_eq!(read[1].radius_pt, Some(3.0));
    assert_eq!(read[2].position.as_deref(), Some("Outside"));
    assert!(has_blur(&m));

    // Reorder: the stroke first.
    let mut r = read.clone();
    r.swap(1, 2);
    set(&mut m, &rect(), "frameEffectStack", r).unwrap();
    assert_eq!(
        kinds(&stack(&m, &rect(), "frameEffectStack"))[1],
        EffectKind::OutlineStroke
    );

    // One undo step per write.
    m.undo().expect("undo reorder");
    assert_eq!(m.current_state_hash(), h1);
    m.undo().expect("undo add");
    assert_eq!(m.current_state_hash(), h0);
    assert!(!has_blur(&m));
    m.redo().expect("redo add");
    assert_eq!(m.current_state_hash(), h1);
}

#[test]
#[allow(non_snake_case)]
fn a_disabled_effect_keeps_and_edits_its_parameters__feat__effects_transparency_effect_stack() {
    let mut m = load();
    let h0 = m.current_state_hash();
    let mut s = stack(&m, &rect(), "frameEffectStack");
    s[0].enabled = false;
    s.push(blur(2.0));
    set(&mut m, &rect(), "frameEffectStack", s).unwrap();
    assert!(
        !page_list(&m)
            .commands
            .iter()
            .any(|c| matches!(c, DisplayCommand::DropShadow { .. })),
        "off"
    );
    // The per-field path reaches the parked parameters.
    m.apply_mutation(&Mutation::Set {
        address: rect().into(),
        path: "frameDropShadowXOffset".into(),
        value: Value::Length(Some(12.0)),
    })
    .expect("x offset");
    let after = stack(&m, &rect(), "frameEffectStack");
    assert!(!after[0].enabled, "still off");
    // `frameDropShadow` true switches it back on in place, with them.
    m.apply_mutation(&Mutation::Set {
        address: rect().into(),
        path: "frameDropShadow".into(),
        value: Value::Bool(true),
    })
    .expect("on");
    let on = stack(&m, &rect(), "frameEffectStack");
    assert_eq!(
        kinds(&on),
        [EffectKind::DropShadow, EffectKind::GaussianBlur]
    );
    assert!(on[0].enabled);
    assert_eq!(
        m.get_property(&rect(), "frameDropShadowXOffset"),
        Ok(Value::Length(Some(12.0)))
    );
    for _ in 0..3 {
        m.undo().expect("undo");
    }
    assert_eq!(m.current_state_hash(), h0);
}

#[test]
#[allow(non_snake_case)]
fn a_text_frame_blurs_its_text__feat__effects_transparency_effect_stack() {
    let mut m = load();
    set(&mut m, &frame(), "frameEffectStack", vec![blur(2.0)]).unwrap();
    let list = page_list(&m);
    let open = list
        .commands
        .iter()
        .position(|c| {
            matches!(
                c,
                DisplayCommand::PushLayer {
                    effect: LayerEffect::GaussianBlur { .. },
                    ..
                }
            )
        })
        .expect("the frame's blur layer");
    let close = (open..list.commands.len())
        .find(|&i| matches!(list.commands[i], DisplayCommand::PopLayer(_)))
        .expect("closed");
    let glyphs_inside = list.commands[open..close]
        .iter()
        .filter(|c| matches!(c, DisplayCommand::FillPath { .. }))
        .count();
    let names: Vec<String> = list
        .commands
        .iter()
        .map(|c| format!("{c:?}").chars().take(40).collect())
        .collect();
    assert!(
        glyphs_inside >= 10,
        "the text is inside the blur: {glyphs_inside} {open} {close} {names:#?}"
    );
}

#[test]
#[allow(non_snake_case)]
fn targets_take_indesign_effects_only__feat__effects_transparency_effect_stack() {
    let mut m = load();
    let h0 = m.current_state_hash();
    let refused = set(&mut m, &rect(), "frameFillEffectStack", vec![blur(2.0)]);
    assert!(
        refused.as_ref().is_err_and(|e| e.contains("object target")),
        "{refused:?}"
    );
    assert_eq!(m.current_state_hash(), h0, "a refusal changes nothing");
    let mut glow = EffectEntrySpec::new(EffectKind::OuterGlow);
    glow.enabled = false;
    set(
        &mut m,
        &rect(),
        "frameFillEffectStack",
        vec![EffectEntrySpec::new(EffectKind::InnerGlow), glow],
    )
    .unwrap();
    assert_eq!(
        kinds(&stack(&m, &rect(), "frameFillEffectStack")),
        [EffectKind::InnerGlow, EffectKind::OuterGlow]
    );
    m.undo().expect("undo");
    assert_eq!(m.current_state_hash(), h0);
}

#[test]
#[allow(non_snake_case)]
fn the_stack_survives_paged_and_idml__feat__effects_transparency_effect_stack() {
    let mut m = load();
    let clean = m.idml_export_losses();
    let mut s = stack(&m, &rect(), "frameEffectStack");
    s.insert(0, outline_stroke());
    set(&mut m, &rect(), "frameEffectStack", s).unwrap();

    // `.paged`.
    m.refresh_model_part().expect("refresh model part");
    let bytes = m
        .export_paged(paged_canvas::channel::PROTOCOL_VERSION.0)
        .expect("export .paged");
    let reloaded = CanvasModel::load("reloaded", &bytes, CanvasOptions::default()).expect("reload");
    assert_eq!(
        kinds(&stack(&reloaded, &rect(), "frameEffectStack")),
        [EffectKind::OutlineStroke, EffectKind::DropShadow]
    );

    // IDML: reported, kept in the label, restored on re-import.
    let losses: Vec<String> = m
        .idml_export_losses()
        .into_iter()
        .filter(|l| !clean.contains(l))
        .collect();
    assert_eq!(losses.len(), 1, "{losses:?}");
    assert!(losses[0].contains("`outlineStroke`") && losses[0].contains("`r1`"));
    let idml = m.export_idml().expect("export idml");
    let again = CanvasModel::load("again", &idml, CanvasOptions::default()).expect("re-import");
    assert_eq!(
        kinds(&stack(&again, &rect(), "frameEffectStack")),
        [EffectKind::OutlineStroke, EffectKind::DropShadow]
    );
    // The shadow itself travelled as InDesign's own setting.
    let twin = idml_import::import_idml_doc(&idml).expect("twin");
    assert!(twin.spreads[0].spread.rectangles[0].drop_shadow.is_some());
}

#[test]
#[allow(non_snake_case)]
fn a_changed_indesign_order_is_reported__feat__effects_transparency_effect_stack() {
    let mut m = load();
    let clean = m.idml_export_losses();
    set(
        &mut m,
        &rect(),
        "frameEffectStack",
        vec![
            EffectEntrySpec::new(EffectKind::Satin),
            EffectEntrySpec::new(EffectKind::DropShadow),
        ],
    )
    .unwrap();
    let losses: Vec<String> = m
        .idml_export_losses()
        .into_iter()
        .filter(|l| !clean.contains(l))
        .collect();
    assert_eq!(losses.len(), 1, "{losses:?}");
    assert!(losses[0].contains("order"), "{}", losses[0]);
}
